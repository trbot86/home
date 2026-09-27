package dev.ourplace.household.storage

import org.json.JSONArray
import org.json.JSONObject
import java.security.MessageDigest
import java.util.UUID
import java.util.concurrent.Callable

fun newId(): String = UUID.randomUUID().toString()
fun sha256(bytes: ByteArray): String = MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }
fun DraftRow.commandKind(): String = if (replyTargetJson == null) "CreateInboxEntry" else "PostSuggestionMessage"
fun DraftRow.json(): JSONObject = JSONObject().put("draftId", draftId).put("clientId", clientId).put("scopeId", scopeId).put("text", text)
    .put("category", category)
    .put("createdAt", createdAt).put("revision", revision).put("state", state).put("attachments", JSONArray(attachmentsJson)).put("settled", settled)
    .apply { replyTargetJson?.let { put("replyTarget", JSONObject(it)) }; frozenJson?.let { put("frozenJson", it) }; frozenHash?.let { put("frozenHash", it) }; outcomeJson?.let { put("outcome", JSONObject(it)) } }

/** Room is authoritative. A worker, bridge, or activity can disappear after any completed call. */
class CaptureStore(private val db: LocalDatabase, private val now: () -> Long = System::currentTimeMillis) {
    private val dao get() = db.dao()
    fun create(clientId: String, scopeId: String, source: String = "typed", category: String = "inbox", replyTarget: JSONObject? = null): DraftRow {
        require(category in listOf("inbox", "app_suggestion")) { "invalid_category" }
        replyTarget?.let { require(it.getString("suggestionId").matches(Regex("[a-zA-Z0-9_-]{8,80}"))); require(it.has("questionId")); if (!it.isNull("questionId")) require(it.getString("questionId").matches(Regex("[a-zA-Z0-9_-]{8,80}"))); it.getBoolean("requestWork") }
        val row = DraftRow(newId(), clientId, scopeId, "", now(), sourceJson = JSONObject().put("kind", source).toString(), category = category, replyTargetJson = replyTarget?.toString())
        dao.insertDraft(row); return row
    }
    fun draft(clientId: String, id: String): DraftRow = dao.draft(id)?.takeIf { it.clientId == clientId } ?: error("draft_unavailable")
    fun save(clientId: String, id: String, text: String, scopeId: String, expectedRevision: Int? = null): DraftRow = db.runInTransaction(Callable {
        val row = draft(clientId, id); check(row.state == "DRAFT") { "draft_locked" }
        check(expectedRevision == null || row.revision == expectedRevision) { "draft_changed_try_again" }
        require(text.length <= 20000) { "text_too_long" }
        row.copy(text = text, scopeId = scopeId, revision = row.revision + 1).also(dao::updateDraft)
    })
    fun attach(clientId: String, id: String, media: MediaRow): DraftRow = db.runInTransaction(Callable {
        val row = draft(clientId, id); check(row.state == "DRAFT") { "draft_locked" }
        val attachments = JSONArray(row.attachmentsJson); require(attachments.length() < 20) { "too_many_photos" }
        check(media.clientId == clientId); dao.insertMedia(media)
        attachments.put(JSONObject().put("attachmentId", newId()).put("mediaId", media.mediaId).put("digest", media.digest)
            .put("byteLength", media.byteLength).put("mimeType", media.mimeType).put("position", attachments.length()))
        row.copy(attachmentsJson = attachments.toString(), revision = row.revision + 1).also(dao::updateDraft)
    })
    fun removePhoto(clientId: String, id: String, mediaId: String): DraftRow = db.runInTransaction(Callable {
        val row = draft(clientId, id); check(row.state == "DRAFT") { "draft_locked" }; val next = JSONArray(); val before = JSONArray(row.attachmentsJson)
        for (i in 0 until before.length()) { val item = before.getJSONObject(i); if (item.getString("mediaId") != mediaId) next.put(item.put("position", next.length())) }
        row.copy(attachmentsJson = next.toString(), revision = row.revision + 1).also(dao::updateDraft)
    })
    fun discard(clientId: String, id: String): DraftRow = db.runInTransaction(Callable {
        val row = draft(clientId, id); check(row.state == "DRAFT") { "draft_locked" }; check(dao.deleteDraft(id) == 1); row
    })
    fun freeze(clientId: String, id: String, serverEpoch: String, requestWork: Boolean? = null): DraftRow = db.runInTransaction(Callable {
        val row = draft(clientId, id); if (row.state != "DRAFT") return@Callable row
        check(row.text.isNotBlank() || JSONArray(row.attachmentsJson).length() > 0) { "add_text_or_a_photo" }
        val target = row.replyTargetJson?.let(::JSONObject)?.apply { if (requestWork != null) put("requestWork", requestWork) }
        val args = if (target != null) JSONObject().put("recordId", row.draftId).put("scopeId", row.scopeId).put("text", row.text)
            .put("suggestionId", target.getString("suggestionId")).put("replyToQuestionId", target.get("questionId"))
            .put("requestWork", target.getBoolean("requestWork")).put("attachments", JSONArray(row.attachmentsJson))
        else JSONObject().put("inboxId", row.draftId).put("scopeId", row.scopeId).put("text", row.text).put("capturedAt", row.createdAt)
            .put("category", row.category)
            .put("source", JSONObject(row.sourceJson)).put("attachments", JSONArray(row.attachmentsJson))
        val frozen = JSONObject().put("operationId", newId()).put("contractVersion", 1).put("expectedServerEpoch", serverEpoch).put("arguments", args).toString()
        row.copy(state = "SUBMITTED", replyTargetJson = target?.toString(), frozenJson = frozen, frozenHash = sha256(frozen.toByteArray(Charsets.UTF_8))).also(dao::updateDraft)
    })
    fun finalise(clientId: String, id: String, outcome: JSONObject) = db.runInTransaction {
        val row = draft(clientId, id); val operationId = JSONObject(row.frozenJson!!).getString("operationId")
        validateOutcome(outcome, operationId)
        val state = when (outcome.getString("status")) { "Applied" -> "ACKNOWLEDGED"; "Rejected" -> "REJECTED"; else -> return@runInTransaction }
        if (row.state == "SUBMITTED") { dao.updateDraft(row.copy(state = state, outcomeJson = outcome.toString())); bumpGeneration(clientId) }
    }
    fun bumpGeneration(clientId: String) { val key = "$clientId:generation"; dao.putValue(ValueRow(key, ((dao.value(key)?.toLong() ?: 0) + 1).toString())) }
    fun validateFrozen(row: DraftRow): JSONObject {
        check(row.frozenJson != null && sha256(row.frozenJson.toByteArray(Charsets.UTF_8)) == row.frozenHash) { "local_capture_integrity_error" }
        return JSONObject(row.frozenJson)
    }
}

fun validateOutcome(outcome: JSONObject, operationId: String) {
    fun keys(value: JSONObject, required: Set<String>, optional: Set<String> = emptySet()) {
        val actual = value.keys().asSequence().toSet(); check(actual.containsAll(required) && (actual - required - optional).isEmpty()) { "invalid_outcome_fields" }
    }
    fun text(value: JSONObject, key: String): String = value.get(key) as? String ?: error("invalid_outcome_text")
    fun id(value: JSONObject, key: String) { check(text(value, key).matches(Regex("[a-zA-Z0-9_-]{8,80}"))) { "invalid_outcome_id" } }
    fun integer(value: JSONObject, key: String, minimum: Long) {
        val n = value.get(key) as? Number ?: error("invalid_outcome_number")
        check(n.toDouble().isFinite() && n.toDouble() == n.toLong().toDouble() && n.toLong() in minimum..9007199254740991L) { "invalid_outcome_number" }
    }
    when (text(outcome, "status")) {
        "Applied", "Rejected" -> {
            val applied = text(outcome, "status") == "Applied"
            keys(outcome, setOf("status", "receipt", if (applied) "result" else "code"), setOf("replayed", if (applied) "changeSetId" else "safeDetails"))
            if (outcome.has("replayed")) check(outcome.get("replayed") is Boolean) { "invalid_outcome_boolean" }
            val receipt = outcome.getJSONObject("receipt"); check(receipt.getString("operationId") == operationId) { "wrong_operation_receipt" }
            keys(receipt, setOf("operationId", "requestDigest", "recordedAt")); id(receipt, "operationId")
            check(text(receipt, "requestDigest").matches(Regex("[a-f0-9]{64}"))) { "invalid_receipt" }; integer(receipt, "recordedAt", 0)
            if (applied) {
                if (outcome.has("changeSetId")) id(outcome, "changeSetId")
                val result = outcome.getJSONObject("result"); keys(result, setOf("records")); val records = result.getJSONArray("records")
                for (i in 0 until records.length()) { val record = records.getJSONObject(i); keys(record, setOf("recordId", "revision")); id(record, "recordId"); integer(record, "revision", 1) }
            } else {
                text(outcome, "code")
                if (outcome.has("safeDetails")) { val details = outcome.getJSONObject("safeDetails"); keys(details, setOf("fields")); val fields = details.getJSONArray("fields"); for (i in 0 until fields.length()) check(fields.get(i) is String) }
            }
        }
        "Deferred" -> { keys(outcome, setOf("status", "code")); text(outcome, "code") }
        "RecoveryRequired" -> { keys(outcome, setOf("status", "currentServerEpoch", "restorePoint")); id(outcome, "currentServerEpoch"); if (!outcome.isNull("restorePoint")) integer(outcome, "restorePoint", 0) }
        else -> error("unsupported_server_outcome")
    }
}
