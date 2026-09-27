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
class CaptureStoreTest {
    @Test fun categoryMigrationPreservesFrozenLegacyCaptureAndNewSuggestionSurvivesReopen() = background {
        val context = ApplicationProvider.getApplicationContext<Context>(); val name = "test-${newId()}.sqlite"
        val schema = JSONObject(javaClass.classLoader!!.getResourceAsStream("dev.ourplace.household.storage.LocalDatabase/1.json")!!.bufferedReader().readText()).getJSONObject("database")
        val clientId = newId(); val scopeId = newId(); val id = newId()
        val frozen = JSONObject().put("operationId", newId()).put("contractVersion", 1).put("expectedServerEpoch", newId())
            .put("arguments", JSONObject().put("inboxId", id).put("scopeId", scopeId).put("text", "Keep this pending thought").put("capturedAt", 1).put("source", JSONObject().put("kind", "typed")).put("attachments", JSONArray())).toString()
        context.openOrCreateDatabase(name, Context.MODE_PRIVATE, null).use { legacy ->
            val entities = schema.getJSONArray("entities")
            for (i in 0 until entities.length()) {
                val entity = entities.getJSONObject(i)
                fun sql(value: String) = value.replace("\${TABLE_NAME}", entity.getString("tableName"))
                legacy.execSQL(sql(entity.getString("createSql")))
                val indices = entity.optJSONArray("indices") ?: JSONArray()
                for (j in 0 until indices.length()) legacy.execSQL(sql(indices.getJSONObject(j).getString("createSql")))
            }
            val setup = schema.getJSONArray("setupQueries"); for (i in 0 until setup.length()) legacy.execSQL(setup.getString(i))
            legacy.execSQL("INSERT INTO drafts VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)", arrayOf<Any?>(id, clientId, scopeId, "Keep this pending thought", 1, 1, "SUBMITTED", "{\"kind\":\"typed\"}", "[]", frozen, sha256(frozen.toByteArray()), null, 0))
            legacy.version = 1
        }
        var db = LocalDatabase.open(context, name)
        try {
            val migrated = db.dao().draft(id)!!
            assertEquals("inbox", migrated.category); assertEquals(frozen, migrated.frozenJson)
            assertEquals(sha256(frozen.toByteArray()), migrated.frozenHash)
            assertFalse(CaptureStore(db).validateFrozen(migrated).getJSONObject("arguments").has("category"))
            val store = CaptureStore(db); val suggestion = store.create(clientId, scopeId, category = "app_suggestion")
            store.save(clientId, suggestion.draftId, "A suggestion without a prefix", scopeId)
            val submitted = store.freeze(clientId, suggestion.draftId, newId())
            db.close(); db = LocalDatabase.open(context, name)
            assertEquals("app_suggestion", db.dao().draft(suggestion.draftId)!!.category)
            assertEquals(submitted.frozenJson, db.dao().draft(suggestion.draftId)!!.frozenJson)
            assertEquals("app_suggestion", CaptureStore(db).validateFrozen(db.dao().draft(suggestion.draftId)!!).getJSONObject("arguments").getString("category"))
        } finally { db.close(); context.deleteDatabase(name) }
    }
    @Test fun sharedContractFixturesRejectCoercionAndMalformedReceipts() {
        val fixtures = JSONArray(javaClass.classLoader!!.getResourceAsStream("outcomes.json")!!.bufferedReader().readText())
        for (i in 0 until fixtures.length()) {
            val fixture = fixtures.getJSONObject(i)
            val valid = runCatching { validateOutcome(fixture.getJSONObject("outcome"), "operation-123") }.isSuccess
            assertEquals(fixture.getString("name"), fixture.getBoolean("valid"), valid)
        }
    }
    private fun background(body: () -> Unit) { val executor = Executors.newSingleThreadExecutor(); try { executor.submit(Callable { body() }).get() } finally { executor.shutdownNow() } }
    @Test fun frozenCaptureSurvivesDatabaseReopenAndCannotBeEdited() = background {
        val context = ApplicationProvider.getApplicationContext<Context>(); val name = "test-${newId()}.sqlite"
        var db = LocalDatabase.open(context, name)
        val store = CaptureStore(db); val clientId = newId(); val scopeId = newId()
        val draft = store.create(clientId, scopeId); store.save(clientId, draft.draftId, "Milk\nToothbrush heads", scopeId)
        val frozen = store.freeze(clientId, draft.draftId, newId()); assertEquals("SUBMITTED", frozen.state)
        assertEquals(frozen.frozenJson, store.freeze(clientId, draft.draftId, newId()).frozenJson)
        assertThrows(IllegalStateException::class.java) { store.save(clientId, draft.draftId, "changed", scopeId) }
        assertThrows(IllegalStateException::class.java) { store.discard(clientId, draft.draftId) }
        db.close(); db = LocalDatabase.open(context, name)
        try {
            val reopened = CaptureStore(db).draft(clientId, draft.draftId)
            assertEquals(frozen.frozenJson, reopened.frozenJson); assertEquals(frozen.frozenHash, reopened.frozenHash)
            assertEquals("Milk\nToothbrush heads", CaptureStore(db).validateFrozen(reopened).getJSONObject("arguments").getString("text"))
            assertThrows(IllegalStateException::class.java) { CaptureStore(db).draft(newId(), draft.draftId) }
        } finally { db.close(); context.deleteDatabase(name) }
    }
    @Test fun lostReplyResolvesReceiptWithoutResendingOrReplacingCurrentCache() = background {
        val context = ApplicationProvider.getApplicationContext<Context>(); val name = "test-${newId()}.sqlite"; var db = LocalDatabase.open(context, name)
        val clientId = newId(); val epoch = newId(); val session = JSONObject().put("clientId", clientId).put("serverEpoch", epoch)
        val captures = CaptureStore(db); val draft = captures.create(clientId, newId()); captures.save(clientId, draft.draftId, "Original thought", draft.scopeId); captures.freeze(clientId, draft.draftId, epoch)
        var receipt: JSONObject? = null; var sends = 0
        val api = object : JsonTransport {
            override fun json(path: String, method: String, body: String?, clientId: String?): JSONObject = when {
                path.startsWith("/operations/") -> receipt ?: JSONObject().put("status", "Unresolved")
                path == "/commands/CreateInboxEntry" -> {
                    sends++; val command = JSONObject(body!!)
                    receipt = JSONObject().put("status", "Applied").put("receipt", JSONObject().put("operationId", command.getString("operationId")).put("requestDigest", "a".repeat(64)).put("recordedAt", 1000))
                        .put("result", JSONObject().put("records", JSONArray().put(JSONObject().put("recordId", draft.draftId).put("revision", 1))))
                    throw java.io.IOException("Simulated connection lost after commit")
                }
                path == "/session" -> session
                path == "/cache/inbox" -> JSONObject().put("serverEpoch", epoch).put("sampledAt", 2000).put("entries", JSONArray().put(JSONObject().put("inboxId", draft.draftId).put("text", "Edited later by partner")))
                else -> error("Unexpected path $path")
            }
        }
        assertThrows(java.io.IOException::class.java) { SyncEngine(db, captures, api) { _, _, _, _ -> error("No photo") }.sync(session) }
        assertEquals("SUBMITTED", captures.draft(clientId, draft.draftId).state); db.close(); db = LocalDatabase.open(context, name)
        try {
            SyncEngine(db, CaptureStore(db), api) { _, _, _, _ -> error("No photo") }.sync(session)
            assertEquals(1, sends); assertEquals("ACKNOWLEDGED", db.dao().draft(draft.draftId)!!.state); assertTrue(db.dao().draft(draft.draftId)!!.settled)
            assertTrue(db.dao().value("$clientId:cache")!!.contains("Edited later by partner"))
        } finally { db.close(); context.deleteDatabase(name) }
    }
    @Test fun staleDraftRevisionAndUnknownOutcomesCannotOverwriteSavedState() = background {
        val context = ApplicationProvider.getApplicationContext<Context>(); val name = "test-${newId()}.sqlite"; val db = LocalDatabase.open(context, name)
        try {
            val store = CaptureStore(db); val draft = store.create(newId(), newId())
            store.save(draft.clientId, draft.draftId, "Latest", draft.scopeId, 1)
            assertThrows(IllegalStateException::class.java) { store.save(draft.clientId, draft.draftId, "Stale", draft.scopeId, 1) }
            val frozen = store.freeze(draft.clientId, draft.draftId, newId())
            assertThrows(IllegalStateException::class.java) { store.finalise(draft.clientId, draft.draftId, JSONObject().put("status", "MaybeSaved")) }
            assertEquals(frozen, store.draft(draft.clientId, draft.draftId))
        } finally { db.close(); context.deleteDatabase(name) }
    }
}
