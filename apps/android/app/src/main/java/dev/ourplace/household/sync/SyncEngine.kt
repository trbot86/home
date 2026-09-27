package dev.ourplace.household.sync

import dev.ourplace.household.platform.JsonTransport
import dev.ourplace.household.storage.*
import org.json.JSONArray
import org.json.JSONObject
import java.util.concurrent.Callable
import java.util.concurrent.locks.ReentrantLock
import kotlin.concurrent.withLock

/** Network calls never run inside a Room transaction. Exact submitted bytes remain unchanged. */
class SyncEngine(private val db: LocalDatabase, private val captures: CaptureStore, private val api: JsonTransport,
                 private val upload: (String, String, JSONObject, String) -> Unit) {
    private val drainLock = ReentrantLock()
    private val dao get() = db.dao()
    fun sync(session: JSONObject) = drainLock.withLock {
        val clientId = session.getString("clientId")
        for (draft in dao.drafts(clientId).filter { it.state == "SUBMITTED" }) {
            val command = captures.validateFrozen(draft); val operationId = command.getString("operationId"); val epoch = command.getString("expectedServerEpoch")
            val resolved = api.json("/operations/$operationId?epoch=$epoch", clientId = clientId)
            val outcome = if (resolved.getString("status") == "Unresolved") {
                val attachments = JSONArray(draft.attachmentsJson)
                for (i in 0 until attachments.length()) upload(draft.clientId, draft.scopeId, attachments.getJSONObject(i), epoch)
                api.json("/commands/${draft.commandKind()}", "POST", draft.frozenJson, clientId)
            } else resolved
            validateOutcome(outcome, operationId)
            if (outcome.getString("status") == "RecoveryRequired") { dao.putValue(ValueRow("$clientId:recovery", "true")); break }
            captures.finalise(clientId, draft.draftId, outcome)
        }
        for (attempt in dao.pendingAttempts(clientId)) resolveAttempt(attempt)
        refresh(session)
    }
    fun resolveAttempt(attempt: AttemptRow): JSONObject = drainLock.withLock {
        dao.attempt(attempt.key)?.takeIf { it.frozenJson == attempt.frozenJson }?.outcomeJson?.let { return@withLock JSONObject(it) }
        val command = JSONObject(attempt.frozenJson); val operationId = command.getString("operationId"); val epoch = command.getString("expectedServerEpoch")
        val resolved = if (attempt.uploadsJson != null) api.json("/operations/$operationId?epoch=$epoch", clientId = attempt.clientId) else JSONObject().put("status", "Unresolved")
        val outcome = if (resolved.getString("status") == "Unresolved") {
            attempt.uploadsJson?.let { val data = JSONObject(it); val photos = data.getJSONArray("attachments")
                for (i in 0 until photos.length()) upload(attempt.clientId, data.getString("scopeId"), photos.getJSONObject(i), epoch) }
            api.json("/commands/${attempt.kind}", "POST", attempt.frozenJson, attempt.clientId)
        } else resolved
        validateOutcome(outcome, operationId)
        finaliseAttempt(attempt, outcome)
        outcome
    }
    fun finaliseAttempt(attempt: AttemptRow, outcome: JSONObject) {
        val operationId = JSONObject(attempt.frozenJson).getString("operationId")
        validateOutcome(outcome, operationId)
        when (outcome.getString("status")) {
            "Applied", "Rejected" -> db.runInTransaction {
                val current = dao.attempt(attempt.key) ?: return@runInTransaction
                if (current.frozenJson != attempt.frozenJson || current.outcomeJson != null) return@runInTransaction
                attempt.attachmentDraftId?.let { id ->
                    val draft = dao.attachmentDraft(id) ?: error("attachment_request_mismatch")
                    check(draft.clientId == attempt.clientId && draft.operationId == operationId) { "attachment_request_mismatch" }
                    dao.updateAttachmentDraft(draft.copy(state = if (outcome.getString("status") == "Applied") "ACKNOWLEDGED" else "REJECTED", outcomeJson = outcome.toString()))
                }
                dao.putAttempt(attempt.copy(outcomeJson = outcome.toString())); captures.bumpGeneration(attempt.clientId)
            }
            "RecoveryRequired" -> dao.putValue(ValueRow("${attempt.clientId}:recovery", "true"))
        }
    }
    fun command(session: JSONObject, recordId: String, kind: String, args: JSONObject, expectedServerEpoch: String): JSONObject = drainLock.withLock {
        val clientId = session.getString("clientId")
        val attempt = db.runInTransaction(Callable {
            val key = "$clientId:$recordId"; check(dao.attempt(key)?.outcomeJson != null || dao.attempt(key) == null) { "previous_save_awaits_acknowledgement" }
            AttemptRow(key, clientId, recordId, kind, JSONObject().put("operationId", newId()).put("contractVersion", 1)
                .put("expectedServerEpoch", expectedServerEpoch).put("arguments", args).toString()).also(dao::putAttempt)
        })
        val outcome = resolveAttempt(attempt); refresh(session); outcome
    }
    fun refresh(session: JSONObject) {
        val clientId = session.getString("clientId"); val generationKey = "$clientId:generation"; val generation = dao.value(generationKey)
        val current = api.json("/session", clientId = clientId); check(current.getString("clientId") == clientId) { "session_changed" }
        val cache = api.json("/cache/inbox", clientId = clientId); check(cache.getString("serverEpoch") == current.getString("serverEpoch")) { "server_changed_try_again" }
        db.runInTransaction {
            if (dao.value(generationKey) != generation) return@runInTransaction
            if (current.getString("serverEpoch") != session.getString("serverEpoch")) {
                dao.value("$clientId:cache")?.let { dao.putValue(ValueRow("$clientId:recovery-cache", it)) }
                dao.putValue(ValueRow("$clientId:recovery", "true"))
            }
            dao.putValue(ValueRow("$clientId:cache", cache.toString())); captures.bumpGeneration(clientId)
            val profileKey = dao.value("activeProfile")
            if (profileKey != null && JSONObject(dao.value(profileKey)!!).getString("clientId") == clientId) dao.putValue(ValueRow(profileKey, current.toString()))
            val entries = cache.getJSONArray("entries"); val ids = (0 until entries.length()).map { entries.getJSONObject(it).getString("inboxId") }.toSet()
            val messages = cache.optJSONObject("suggestions")?.optJSONArray("messages") ?: JSONArray()
            val messageIds = (0 until messages.length()).map { messages.getJSONObject(it).getString("recordId") }.toSet()
            for (draft in dao.drafts(clientId).filter { it.state == "ACKNOWLEDGED" && it.draftId in (if (it.replyTargetJson == null) ids else messageIds) }) dao.updateDraft(draft.copy(settled = true))
        }
    }
}
