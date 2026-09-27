package dev.ourplace.household

import android.content.Context
import dev.ourplace.household.platform.*
import dev.ourplace.household.storage.*
import dev.ourplace.household.sync.SyncEngine
import dev.ourplace.household.sync.UploadWorker
import org.json.JSONArray
import org.json.JSONObject
import java.io.ByteArrayInputStream
import java.io.File
import java.io.FileOutputStream
import java.util.concurrent.CopyOnWriteArraySet
import java.util.concurrent.Executors
import java.util.concurrent.Callable
import dev.ourplace.household.widgets.TaskWidget

class ClientCore private constructor(val context: Context) {
    val db = LocalDatabase.open(context); val captures = CaptureStore(db); val media = MediaStore(context, db)
    val attachmentDrafts = AttachmentDraftStore(db)
    private val credentials = CredentialStore(context)
    private val dao get() = db.dao()
    private val api = ServerApi({ endpoint().ifBlank { error("server_address_required") } }, credentials)
    val executor = Executors.newSingleThreadExecutor()
    private val listeners = CopyOnWriteArraySet<() -> Unit>()
    @Volatile private var online = false
    private val syncEngine = SyncEngine(db, captures, api) { ownerClientId, scopeId, attachment, epoch ->
        val mediaId = attachment.getString("mediaId")
        val prepare = JSONObject().put("scopeId", scopeId).put("expectedServerEpoch", epoch).put("digest", attachment.getString("digest"))
            .put("byteLength", attachment.getLong("byteLength")).put("mimeType", attachment.getString("mimeType"))
        val result = api.json("/media/$mediaId/prepare", "POST", prepare.toString(), ownerClientId)
        if (result.getString("state") != "ready") api.bytes("/media/$mediaId/bytes", "PUT", media.read(ownerClientId, mediaId), ownerClientId, epoch)
    }
    fun subscribe(listener: () -> Unit): () -> Unit { listeners.add(listener); return { listeners.remove(listener) } }
    fun changed() { listeners.forEach { it() }; TaskWidget.refreshAll(context) }
    fun session(): JSONObject? = dao.value("activeProfile")?.let { dao.value(it) }?.let(::JSONObject)
    fun requireSession(): JSONObject = session() ?: error("sign_in_required")
    fun clientId(): String = requireSession().getString("clientId")
    fun configure(url: String) {
        check(session() == null) { "sign_out_before_changing_server" }
        dao.putValue(ValueRow("endpoint", ServerApi.validateEndpoint(url))); changed()
    }
    fun endpoint(): String {
        dao.value("endpoint")?.let { return it }
        val compiled = BuildConfig.DEFAULT_SERVER_ORIGIN
        if (compiled.isBlank()) return ""
        // Pin the initial default locally so a later APK cannot silently move saved work to another server.
        return db.runInTransaction(Callable {
            dao.value("endpoint") ?: ServerApi.validateEndpoint(compiled).also { dao.putValue(ValueRow("endpoint", it)) }
        })
    }
    fun authenticationOptions(): JSONObject = api.json("/auth/options")
    fun login(username: String, password: String): JSONObject {
        val profile = "profile:${endpoint()}:${username.trim().lowercase()}"; val previous = dao.value(profile)?.let(::JSONObject)
        val args = JSONObject().put("username", username.trim().lowercase()).put("clientKind", "android")
        if (password.isNotEmpty()) args.put("password", password)
        previous?.let { args.put("clientId", it.getString("clientId")) }
        val result = api.json("/auth/login", "POST", args.toString())
        credentials.put(result.getString("clientId"), result.getString("credential")); result.remove("credential")
        TaskWidget.profileChange(context) {
            db.runInTransaction { dao.putValue(ValueRow(profile, result.toString())); dao.putValue(ValueRow("activeProfile", profile)) }
        }
        online = true; try { refresh() } finally { changed() }; return result
    }
    fun logout() {
        val clientId = clientId()
        try { api.json("/auth/logout", "POST", "{}", clientId) } catch (error: ApiException) { if (error.status != 401) throw error }
        TaskWidget.profileChange(context) { credentials.remove(clientId); dao.deleteValue("activeProfile") }; changed()
    }
    fun state(): JSONObject {
        val session = session(); val clientId = session?.getString("clientId"); val cache = clientId?.let { dao.value("$it:cache") }?.let(::JSONObject)
        val drafts = JSONArray(); if (clientId != null) dao.drafts(clientId).filter { !it.settled }.forEach { drafts.put(it.json()) }
        val pending = JSONArray(); if (clientId != null) dao.pendingAttempts(clientId).forEach { pending.put(it.recordId) }
        return JSONObject().put("session", session ?: JSONObject.NULL).put("entries", cache?.getJSONArray("entries") ?: JSONArray()).put("drafts", drafts)
            .put("shopping", (cache?.optJSONObject("shopping") ?: JSONObject().put("lists", JSONArray()).put("entries", JSONArray()).put("restockItems", JSONArray()).put("purchases", JSONArray())).apply { if (!has("groups")) put("groups", JSONArray()) })
            .put("tasks", cache?.optJSONObject("tasks") ?: JSONObject().put("definitions", JSONArray()).put("occurrences", JSONArray()).put("completions", JSONArray()).put("people", JSONArray()).put("timeZone", "America/Toronto"))
            .put("home", cache?.optJSONObject("home") ?: JSONObject().put("assets", JSONArray()).put("serviceRecords", JSONArray()))
            .put("recipes", cache?.optJSONObject("recipes") ?: JSONObject().put("recipes", JSONArray()).put("collections", JSONArray()).put("cookingRecords", JSONArray()))
            .put("projects", cache?.optJSONObject("projects") ?: JSONObject().put("projects", JSONArray()).put("pages", JSONArray()))
            .put("suggestions", cache?.optJSONObject("suggestions") ?: JSONObject().put("workflows", JSONArray()).put("messages", JSONArray()).put("questions", JSONArray()).put("work", JSONArray()).put("bridgeSeenAt", JSONObject.NULL).put("messagesPerSuggestion", 100))
            .put("recipeImports", cache?.optJSONArray("recipeImports") ?: JSONArray())
            .put("views", cache?.optJSONArray("views") ?: JSONArray())
            .put("agenda", cache?.optJSONObject("agenda") ?: JSONObject().put("configured", false).put("calendars", JSONArray()).put("needsReconnect", false).put("issue", JSONObject.NULL).put("sampledAt", JSONObject.NULL))
            .put("online", online).put("sampledAt", cache?.getLong("sampledAt") ?: JSONObject.NULL).put("pendingEdits", pending)
            .put("recoveryRequired", clientId != null && dao.value("$clientId:recovery") == "true")
    }
    fun widgetState(): JSONObject = db.runInTransaction(Callable {
        val current = session()
        val owner = current?.getString("clientId")
        val cache = owner?.let { dao.value("$it:cache") }?.let(::JSONObject)
        JSONObject().put("session", current ?: JSONObject.NULL)
            .put("taskWidget", cache?.optJSONObject("taskWidget") ?: JSONObject.NULL)
            .put("sampledAt", cache?.optLong("sampledAt") ?: JSONObject.NULL)
            .put("recoveryRequired", owner != null && dao.value("$owner:recovery") == "true")
    })
    fun createDraft(scopeId: String, source: String = "typed", category: String = "inbox", replyTarget: JSONObject? = null): DraftRow = captures.create(clientId(), scopeId, source, category, replyTarget).also { changed() }
    fun saveDraft(id: String, text: String, scopeId: String, revision: Int? = null): DraftRow = captures.save(clientId(), id, text, scopeId, revision).also { changed() }
    fun submitDraft(id: String, requestWork: Boolean? = null) { val session = requireSession(); captures.freeze(session.getString("clientId"), id, session.getString("serverEpoch"), requestWork); changed(); UploadWorker.schedule(context) }
    fun discardDraft(id: String) { val clientId = clientId(); val row = captures.discard(clientId, id); val attachments = JSONArray(row.attachmentsJson); for (i in 0 until attachments.length()) media.remove(clientId, attachments.getJSONObject(i).getString("mediaId")); changed() }
    fun addPhoto(id: String, bytes: ByteArray, mimeType: String): DraftRow {
        val clientId = clientId(); val row = media.acquire(clientId, mimeType, ByteArrayInputStream(bytes))
        try { return captures.attach(clientId, id, row).also { changed() } }
        finally { media.removeUnattached(row) }
    }
    fun removePhoto(id: String, mediaId: String): DraftRow { val clientId = clientId(); val draft = captures.removePhoto(clientId, id, mediaId); media.remove(clientId, mediaId); changed(); return draft }
    fun openAttachmentDraft(recordId: String, scopeId: String, revision: Int, photos: JSONArray): AttachmentDraftRow = attachmentDrafts.open(requireSession(), recordId, scopeId, revision, photos)
    fun saveAttachmentDraft(id: String, revision: Int, photos: JSONArray): AttachmentDraftRow = attachmentDrafts.save(clientId(), id, revision, photos).also { changed() }
    fun addAttachmentPhoto(id: String, bytes: ByteArray, mimeType: String): AttachmentDraftRow {
        val owner = clientId(); val photo = media.acquire(owner, mimeType, ByteArrayInputStream(bytes))
        try { return attachmentDrafts.attach(owner, id, photo).also { changed() } }
        finally { media.removeUnattached(photo) }
    }
    fun discardAttachmentDraft(id: String) {
        val owner = clientId(); val draft = attachmentDrafts.discard(owner, id); val ids = JSONArray(draft.localMediaIdsJson)
        for (i in 0 until ids.length()) media.remove(owner, ids.getString(i)); changed()
    }
    fun submitAttachmentDraft(id: String): JSONObject {
        check(online) { "existing_entries_are_read_only_offline" }; val session = requireSession()
        val attempt = attachmentDrafts.freeze(session, id); changed(); UploadWorker.schedule(context)
        try { val outcome = syncEngine.resolveAttempt(attempt); syncEngine.refresh(session); return outcome } finally { changed() }
    }
    fun copyRejected(id: String): DraftRow {
        val clientId = clientId(); val row = captures.draft(clientId, id); check(row.state == "REJECTED") { "draft_unavailable" }
        var copy = captures.create(clientId, row.scopeId, category = row.category, replyTarget = row.replyTargetJson?.let(::JSONObject)); copy = captures.save(clientId, copy.draftId, row.text, row.scopeId)
        val attachments = JSONArray(row.attachmentsJson)
        for (i in 0 until attachments.length()) { val photo = attachments.getJSONObject(i); copy = addPhoto(copy.draftId, media.read(clientId, photo.getString("mediaId")), photo.getString("mimeType")) }
        dao.updateDraft(row.copy(settled = true)); changed(); return copy
    }
    fun sync() { val current = session() ?: return; try { syncEngine.sync(current); online = true; cleanAcknowledgedMedia(current.getString("clientId")) } catch (error: Exception) { if (error is ApiException) online = error.status != 0; throw error } finally { changed() } }
    fun refresh() { try { syncEngine.refresh(requireSession()); online = true } catch (error: Exception) { if (error is ApiException) online = error.status != 0; throw error } finally { changed() } }
    private fun cleanAcknowledgedMedia(clientId: String) {
        // Settled originals are expendable cache. Pending/rejected captures never enter this set.
        val candidates = dao.drafts(clientId).filter { it.settled }.flatMap { draft ->
            val photos = JSONArray(draft.attachmentsJson)
            (0 until photos.length()).mapNotNull { dao.media(photos.getJSONObject(it).getString("mediaId")) }
        }.distinctBy { it.mediaId }.sortedByDescending { File(it.path).lastModified() }
        var retained = 0L
        for (photo in candidates) {
            retained += photo.byteLength
            if (retained > 64L * 1024 * 1024) media.remove(clientId, photo.mediaId)
        }
        for (orphan in media.root.listFiles() ?: emptyArray()) {
            if (orphan.name.matches(Regex("[a-f0-9-]{36}\\.(bin|partial)")) && orphan.lastModified() < System.currentTimeMillis() - 86400000L && dao.media(orphan.name.substringBefore('.')) == null) orphan.delete()
        }
    }
    fun command(recordId: String, kind: String, args: JSONObject, expectedServerEpoch: String): JSONObject { check(online) { "existing_entries_are_read_only_offline" }; try { return syncEngine.command(requireSession(), recordId, kind, args, expectedServerEpoch) } finally { changed() } }
    fun history(id: String): JSONArray = api.json("/inbox/$id/history", clientId = clientId()).getJSONArray("entries")
    fun suggestionMessages(id: String, before: Long): JSONArray { require(id.matches(Regex("[a-zA-Z0-9_-]{8,80}")) && before > 0); return api.json("/suggestions/$id/messages?before=$before", clientId = clientId()).getJSONArray("messages") }
    fun shoppingHistory(id: String): JSONArray = api.json("/shopping/$id/history", clientId = clientId()).getJSONArray("entries")
    fun recordHistory(id: String): JSONArray = api.json("/records/$id/history", clientId = clientId()).getJSONArray("entries")
    fun recipeImport(id: String): JSONObject = api.json("/recipe-imports/${java.net.URLEncoder.encode(id, "UTF-8")}", clientId = clientId())
    fun saveEditor(id: String, text: String, baseRevision: Int, serverEpoch: String) { dao.putValue(ValueRow("${clientId()}:editor:$id", JSONObject().put("text", text).put("baseRevision", baseRevision).put("serverEpoch", serverEpoch).toString())) }
    fun readEditor(id: String): JSONObject? = dao.value("${clientId()}:editor:$id")?.let(::JSONObject)
    fun clearEditor(id: String) = dao.deleteValue("${clientId()}:editor:$id")
    fun storage(): JSONObject = api.json("/storage", clientId = clientId())
    fun localStorage(): JSONObject = JSONObject().put("databaseBytes", context.databaseList().sumOf { context.getDatabasePath(it).length() })
        .put("mediaBytes", listOf(media.root, File(context.filesDir, "photo-acquisitions"), File(context.cacheDir, clientId())).sumOf { root -> root.walkTopDown().filter { it.isFile }.sumOf { it.length() } }).put("sampledAt", System.currentTimeMillis())
    fun backups(): JSONObject = api.json("/backups", clientId = clientId())
    fun createBackup() { api.json("/backups", "POST", "{}", clientId()) }
    fun recoverDraft(id: String): DraftRow? {
        val clientId = clientId(); val row = captures.draft(clientId, id); check(row.state == "SUBMITTED")
        val command = captures.validateFrozen(row)
        val result = api.json("/recovery/abandon", "POST", JSONObject().put("kind", row.commandKind()).put("command", command).toString(), clientId)
        captures.finalise(clientId, id, result); refresh(); changed()
        return if (result.getString("status") == "Rejected") copyRejected(id) else null
    }
    fun reconcileEdits() {
        val session = requireSession(); val clientId = session.getString("clientId")
        for (attempt in dao.pendingAttempts(clientId)) {
            val command = JSONObject(attempt.frozenJson); if (command.getString("expectedServerEpoch") == session.getString("serverEpoch")) continue
            val result = api.json("/recovery/abandon", "POST", JSONObject().put("kind", attempt.kind).put("command", command).toString(), clientId)
            validateOutcome(result, command.getString("operationId"))
            syncEngine.finaliseAttempt(attempt, result)
        }
        refresh(); changed()
    }
    fun photoPath(id: String, descriptor: JSONObject? = null): String {
        val clientId = clientId(); dao.media(id)?.takeIf { it.clientId == clientId }?.let { media.read(clientId, id); File(it.path).setLastModified(System.currentTimeMillis()); return it.path }
        // Resolve the ID through an authorised cached record before fetching or serving a cached image.
        val cache = dao.value("$clientId:cache")?.let(::JSONObject) ?: error("photo_unavailable")
        val tasks = cache.optJSONObject("tasks")
        val home = cache.optJSONObject("home")
        val recipes = cache.optJSONObject("recipes")
        val projects = cache.optJSONObject("projects")
        val records = listOfNotNull(cache.optJSONArray("entries"), tasks?.optJSONArray("definitions"), tasks?.optJSONArray("completions"), home?.optJSONArray("assets"), home?.optJSONArray("serviceRecords"), recipes?.optJSONArray("recipes"), recipes?.optJSONArray("cookingRecords"), projects?.optJSONArray("projects"), projects?.optJSONArray("pages"), cache.optJSONObject("suggestions")?.optJSONArray("messages"))
        var attachment: JSONObject? = descriptor?.takeIf { it.optString("mediaId") == id }
        for (entries in records) for (i in 0 until entries.length()) {
            val photos = entries.getJSONObject(i).optJSONArray("attachments") ?: continue
            for (j in 0 until photos.length()) if (photos.getJSONObject(j).getString("mediaId") == id) attachment = photos.getJSONObject(j)
        }
        // A history descriptor supplies integrity metadata only. The server still
        // authorises any download; the disk cache is isolated to this profile.
        val info = attachment ?: error("photo_unavailable")
        val directory = File(context.cacheDir, clientId).apply { mkdirs() }; require(id.matches(Regex("[a-zA-Z0-9_-]{8,80}")))
        val file = File(directory, "$id.bin")
        if (!file.exists() || file.length() != info.getLong("byteLength") || sha256(file.readBytes()) != info.getString("digest")) {
            val bytes = api.bytes("/media/$id", clientId = clientId)
            check(bytes.size.toLong() == info.getLong("byteLength") && sha256(bytes) == info.getString("digest")) { "photo_integrity_error" }
            val partial = File(directory, "$id.partial")
            FileOutputStream(partial).use { it.write(bytes); it.fd.sync() }
            check(partial.renameTo(file)) { "photo_publication_failed" }
        }
        file.setLastModified(System.currentTimeMillis())
        var retained = file.length()
        for (old in (directory.listFiles() ?: emptyArray()).filter { it != file }.sortedByDescending { it.lastModified() }) {
            retained += old.length(); if (retained > 64L * 1024 * 1024) old.delete()
        }
        return file.path
    }
    companion object {
        @Volatile private var instance: ClientCore? = null
        fun get(context: Context): ClientCore = instance ?: synchronized(this) { instance ?: ClientCore(context.applicationContext).also { instance = it } }
    }
}
