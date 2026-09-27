package dev.ourplace.household.storage

import org.json.JSONArray
import org.json.JSONObject
import java.util.concurrent.Callable

fun AttachmentDraftRow.json(): JSONObject = JSONObject().put("draftId", draftId).put("clientId", clientId).put("recordId", recordId)
    .put("scopeId", scopeId).put("baseRevision", baseRevision).put("serverEpoch", serverEpoch).put("revision", revision)
    .put("attachments", JSONArray(attachmentsJson)).put("localMediaIds", JSONArray(localMediaIdsJson)).put("state", state)
    .apply { operationId?.let { put("operationId", it) }; outcomeJson?.let { put("outcome", JSONObject(it)) } }

class AttachmentDraftStore(private val db: LocalDatabase) {
    private val dao get() = db.dao()
    fun read(clientId: String, id: String): AttachmentDraftRow = dao.attachmentDraft(id)?.takeIf { it.clientId == clientId } ?: error("attachment_draft_unavailable")
    fun open(session: JSONObject, recordId: String, scopeId: String, revision: Int, attachments: JSONArray): AttachmentDraftRow = db.runInTransaction(Callable {
        val clientId = session.getString("clientId")
        dao.attachmentDraftFor(clientId, recordId)?.let { return@Callable it }
        val scopes = session.getJSONArray("scopes"); check((0 until scopes.length()).any { scopes.getJSONObject(it).getString("scopeId") == scopeId }) { "scope_unavailable" }
        AttachmentDraftRow(newId(), clientId, recordId, scopeId, revision, session.getString("serverEpoch"), attachmentsJson = attachments.toString()).also(dao::insertAttachmentDraft)
    })
    fun save(clientId: String, id: String, revision: Int, attachments: JSONArray): AttachmentDraftRow = db.runInTransaction(Callable {
        val row = read(clientId, id); check(row.state == "DRAFT" && row.revision == revision) { "draft_changed_try_again" }
        require(attachments.length() <= 20); val old = JSONArray(row.attachmentsJson); val seen = mutableSetOf<String>()
        for (i in 0 until attachments.length()) {
            val a = attachments.getJSONObject(i); check(seen.add(a.getString("attachmentId"))) { "invalid_attachment_edit" }
            check((0 until old.length()).any { n -> val b = old.getJSONObject(n); listOf("attachmentId", "mediaId", "digest", "byteLength", "mimeType").all { a.get(it) == b.get(it) } }) { "invalid_attachment_edit" }
            check(a.optString("caption", "").length <= 1000); a.put("position", i)
        }
        row.copy(revision = row.revision + 1, attachmentsJson = attachments.toString()).also(dao::updateAttachmentDraft)
    })
    fun attach(clientId: String, id: String, media: MediaRow): AttachmentDraftRow = db.runInTransaction(Callable {
        val row = read(clientId, id); check(row.state == "DRAFT") { "draft_locked" }
        val attachments = JSONArray(row.attachmentsJson); require(attachments.length() < 20) { "too_many_photos" }; check(media.clientId == clientId)
        dao.insertMedia(media)
        attachments.put(JSONObject().put("attachmentId", newId()).put("mediaId", media.mediaId).put("digest", media.digest)
            .put("byteLength", media.byteLength).put("mimeType", media.mimeType).put("position", attachments.length()))
        row.copy(attachmentsJson = attachments.toString(), localMediaIdsJson = JSONArray(row.localMediaIdsJson).put(media.mediaId).toString(), revision = row.revision + 1).also(dao::updateAttachmentDraft)
    })
    fun discard(clientId: String, id: String): AttachmentDraftRow = db.runInTransaction(Callable {
        val row = read(clientId, id); check(row.state != "SUBMITTED") { "draft_locked" }; check(dao.deleteAttachmentDraft(id) == 1); row
    })
    fun freeze(session: JSONObject, id: String): AttemptRow = db.runInTransaction(Callable {
        val clientId = session.getString("clientId"); val row = read(clientId, id); val key = "$clientId:${row.recordId}"; val existing = dao.attempt(key)
        if (row.state == "SUBMITTED" && existing?.attachmentDraftId == id && JSONObject(existing.frozenJson).getString("operationId") == row.operationId) return@Callable existing
        check(row.state == "DRAFT" && (existing == null || existing.outcomeJson != null)) { "previous_save_awaits_acknowledgement" }
        check(row.serverEpoch == session.getString("serverEpoch")) { "recovery_required" }
        val operationId = newId(); val photos = JSONArray(row.attachmentsJson); val ids = JSONArray(row.localMediaIdsJson); val uploads = JSONArray()
        for (i in 0 until photos.length()) { val a = photos.getJSONObject(i); if ((0 until ids.length()).any { ids.getString(it) == a.getString("mediaId") }) uploads.put(a) }
        val frozen = JSONObject().put("operationId", operationId).put("contractVersion", 1).put("expectedServerEpoch", row.serverEpoch)
            .put("arguments", JSONObject().put("recordId", row.recordId).put("expectedRevision", row.baseRevision).put("attachments", photos)).toString()
        val attempt = AttemptRow(key, clientId, row.recordId, "SetRecordAttachments", frozen, attachmentDraftId = id,
            uploadsJson = JSONObject().put("scopeId", row.scopeId).put("attachments", uploads).toString())
        dao.putAttempt(attempt); dao.updateAttachmentDraft(row.copy(state = "SUBMITTED", operationId = operationId)); attempt
    })
}
