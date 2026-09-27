package dev.ourplace.household

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import dev.ourplace.household.storage.*
import dev.ourplace.household.platform.JsonTransport
import dev.ourplace.household.sync.SyncEngine
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import java.util.concurrent.Executors
import java.util.concurrent.Callable

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], manifest = Config.NONE)
class AttachmentDraftStoreTest {
    private fun background(body: () -> Unit) { val worker = Executors.newSingleThreadExecutor(); try { worker.submit(Callable { body() }).get() } finally { worker.shutdownNow() } }
    private fun receipt(attempt: AttemptRow, applied: Boolean = true): JSONObject = JSONObject().put("status", if (applied) "Applied" else "Rejected")
        .put("receipt", JSONObject().put("operationId", JSONObject(attempt.frozenJson).getString("operationId")).put("requestDigest", "a".repeat(64)).put("recordedAt", 1000))
        .apply { if (applied) put("result", JSONObject().put("records", JSONArray().put(JSONObject().put("recordId", attempt.recordId).put("revision", 2)))) else put("code", "revision_conflict") }

    @Test fun migrationKeepsOldAttemptsMediaAndInterruptedCameraOwnership() = background {
        val context = ApplicationProvider.getApplicationContext<Context>(); val name = "test-${newId()}.sqlite"
        val schema = JSONObject(javaClass.classLoader!!.getResourceAsStream("dev.ourplace.household.storage.LocalDatabase/2.json")!!.bufferedReader().readText()).getJSONObject("database")
        val owner = newId(); val record = newId(); val media = newId(); val acquisition = newId(); val frozen = "{\"unchanged\":true}"
        context.openOrCreateDatabase(name, Context.MODE_PRIVATE, null).use { old ->
            val entities = schema.getJSONArray("entities")
            for (i in 0 until entities.length()) {
                val entity = entities.getJSONObject(i)
                fun sql(value: String) = value.replace("\${TABLE_NAME}", entity.getString("tableName"))
                old.execSQL(sql(entity.getString("createSql")))
                val indices = entity.optJSONArray("indices") ?: JSONArray()
                for (j in 0 until indices.length()) old.execSQL(sql(indices.getJSONObject(j).getString("createSql")))
            }
            val setup = schema.getJSONArray("setupQueries"); for (i in 0 until setup.length()) old.execSQL(setup.getString(i))
            old.execSQL("INSERT INTO attempts VALUES(?,?,?,?,?,?)", arrayOf<Any?>("$owner:$record", owner, record, "SetInboxEntryText", frozen, null))
            old.execSQL("INSERT INTO media VALUES(?,?,?,?,?,?)", arrayOf<Any>(media, owner, "/synthetic/photo.bin", "a".repeat(64), 12, "image/png"))
            old.execSQL("INSERT INTO acquisitions VALUES(?,?,?,?,?,?,?)", arrayOf<Any>(acquisition, owner, record, "/synthetic/pending.jpg", "camera", "pending", 1))
            old.version = 2
        }
        val db = LocalDatabase.open(context, name)
        try {
            assertEquals(frozen, db.dao().attempt("$owner:$record")!!.frozenJson)
            assertNull(db.dao().attempt("$owner:$record")!!.uploadsJson)
            assertEquals(owner, db.dao().media(media)!!.clientId)
            assertEquals("inbox", db.dao().acquisition(acquisition)!!.targetKind)
            assertEquals("pending", db.dao().acquisition(acquisition)!!.state)
        } finally { db.close(); context.deleteDatabase(name) }
    }

    @Test fun interruptedPhotoSaveResolvesOnceAndLateReplyCannotOverwriteNewAttempt() = background {
        val context = ApplicationProvider.getApplicationContext<Context>(); val name = "test-${newId()}.sqlite"; var db = LocalDatabase.open(context, name)
        val owner = newId(); val scope = newId(); val record = newId(); val session = JSONObject().put("clientId", owner).put("serverEpoch", newId()).put("scopes", JSONArray().put(JSONObject().put("scopeId", scope)))
        val store = AttachmentDraftStore(db); val draft = store.open(session, record, scope, 1, JSONArray())
        val media = MediaRow(newId(), owner, "/synthetic/photo.bin", "a".repeat(64), 12, "image/png")
        val added = store.attach(owner, draft.draftId, media)
        assertThrows(IllegalStateException::class.java) { store.save(owner, draft.draftId, 1, JSONArray()) }
        val photos = JSONArray(added.attachmentsJson); photos.getJSONObject(0).put("caption", "Receipt kept through restart")
        store.save(owner, draft.draftId, added.revision, photos)
        val attempt = store.freeze(session, draft.draftId)
        assertThrows(IllegalStateException::class.java) { store.discard(owner, draft.draftId) }
        assertThrows(IllegalStateException::class.java) { store.read(newId(), draft.draftId) }
        assertEquals(attempt.frozenJson, store.freeze(session, draft.draftId).frozenJson)
        var committed: JSONObject? = null; var uploads = 0; var sends = 0
        val api = object : JsonTransport {
            override fun json(path: String, method: String, body: String?, clientId: String?): JSONObject = when {
                path.startsWith("/operations/") -> committed ?: JSONObject().put("status", "Unresolved")
                path == "/commands/SetRecordAttachments" -> { sends++; committed = receipt(attempt); throw java.io.IOException("Lost reply") }
                else -> error("Unexpected request $path")
            }
        }
        assertThrows(java.io.IOException::class.java) { SyncEngine(db, CaptureStore(db), api) { _, _, _, _ -> uploads++ }.resolveAttempt(attempt) }
        db.close(); db = LocalDatabase.open(context, name)
        try {
            val engine = SyncEngine(db, CaptureStore(db), api) { _, _, _, _ -> uploads++ }
            engine.resolveAttempt(db.dao().attempt(attempt.key)!!)
            assertEquals(1, sends); assertEquals(1, uploads)
            val saved = AttachmentDraftStore(db).read(owner, draft.draftId)
            assertEquals("ACKNOWLEDGED", saved.state); assertTrue(saved.attachmentsJson.contains("Receipt kept through restart"))
            AttachmentDraftStore(db).discard(owner, draft.draftId)
            val newer = attempt.copy(frozenJson = JSONObject(attempt.frozenJson).put("operationId", newId()).toString(), attachmentDraftId = null, uploadsJson = null)
            db.dao().putAttempt(newer)
            engine.finaliseAttempt(attempt, committed!!)
            assertEquals(newer, db.dao().attempt(attempt.key))
        } finally { db.close(); context.deleteDatabase(name) }
    }

    @Test fun rejectedRecoveryUnlocksDraftButRetainsOriginalPhotos() = background {
        val context = ApplicationProvider.getApplicationContext<Context>(); val name = "test-${newId()}.sqlite"; val db = LocalDatabase.open(context, name)
        try {
            val owner = newId(); val scope = newId(); val session = JSONObject().put("clientId", owner).put("serverEpoch", newId()).put("scopes", JSONArray().put(JSONObject().put("scopeId", scope)))
            val store = AttachmentDraftStore(db); val draft = store.open(session, newId(), scope, 8, JSONArray())
            val media = MediaRow(newId(), owner, "/synthetic/photo.bin", "a".repeat(64), 12, "image/png"); store.attach(owner, draft.draftId, media)
            val attempt = store.freeze(session, draft.draftId)
            val api = object : JsonTransport { override fun json(path: String, method: String, body: String?, clientId: String?): JSONObject = error("No network required") }
            val engine = SyncEngine(db, CaptureStore(db), api) { _, _, _, _ -> error("No upload") }
            engine.finaliseAttempt(attempt, receipt(attempt, false))
            assertEquals("REJECTED", store.read(owner, draft.draftId).state)
            assertNotNull(db.dao().media(media.mediaId)); assertTrue(db.dao().pendingAttempts(owner).isEmpty())
            store.discard(owner, draft.draftId)
        } finally { db.close(); context.deleteDatabase(name) }
    }
}
