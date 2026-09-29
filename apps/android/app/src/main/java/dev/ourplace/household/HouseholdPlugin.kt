package dev.ourplace.household

import android.content.Intent
import android.os.Handler
import android.os.Looper
import android.util.Base64
import com.getcapacitor.*
import com.getcapacitor.annotation.CapacitorPlugin
import dev.ourplace.household.capture.PhotoCaptureActivity
import dev.ourplace.household.capture.QuickCaptureActivity
import dev.ourplace.household.storage.json
import dev.ourplace.household.platform.WebLinks
import dev.ourplace.household.platform.AppVersion
import dev.ourplace.household.widgets.WidgetNavigation
import org.json.JSONObject
import java.util.concurrent.Executors

@CapacitorPlugin(name = "Household")
class HouseholdPlugin : Plugin() {
    private lateinit var core: ClientCore
    private val network = Executors.newSingleThreadExecutor()
    private var unsubscribe: (() -> Unit)? = null
    override fun load() {
        core = ClientCore.get(context)
        unsubscribe = core.subscribe { Handler(Looper.getMainLooper()).post { notifyListeners("changed", JSObject()) } }
        core.executor.execute { WidgetNavigation.accept(core, activity.intent) }
        network.execute { runCatching { core.sync() } }
    }
    override fun handleOnResume() { network.execute { runCatching { core.sync() } } }
    override fun handleOnDestroy() { unsubscribe?.invoke(); network.shutdown() }
    override fun handleOnNewIntent(intent: Intent) { core.executor.execute { WidgetNavigation.accept(core, intent) } }
    @PluginMethod fun invoke(call: PluginCall) {
        val method = call.getString("method") ?: return call.reject("method_required")
        val args = call.getObject("args") ?: JSObject()
        if (method == "appVersion" || method == "publishedAppVersion") {
            network.execute {
                try {
                    val value = if (method == "appVersion") AppVersion.installed(context)
                        else AppVersion.published(core.endpoint())
                    call.resolve(JSObject().put("value", value))
                } catch (error: Exception) { call.reject("Could not check app version", error) }
            }
            return
        }
        if (method == "openExternalUrl") {
            try {
                val intent = WebLinks.intent(args.requireText("url"))
                activity.runOnUiThread {
                    try { activity.startActivity(intent); call.resolve(JSObject().put("value", JSONObject.NULL)) }
                    catch (error: Exception) { call.reject("Could not open a browser", error) }
                }
            } catch (error: Exception) { call.reject("Invalid web link", error) }
            return
        }
        val networkMethods = setOf("authenticationOptions", "login", "logout", "refresh", "sync", "command", "submitAttachmentDraft", "history", "shoppingHistory", "recordHistory", "sharingPreview", "recordSecurity", "shoppingSettings", "filingAdviceSettings", "saveFilingAdviceSettings", "filingAdvice", "recipeImport", "photoPath", "storage", "backups", "createBackup", "recoverDraft", "reconcileEdits")
        (if (method in networkMethods) network else core.executor).execute {
            try {
                val result: Any? = when (method) {
                    "state" -> core.state()
                    "takeWidgetNavigation" -> WidgetNavigation.take(core)
                    "endpoint" -> core.endpoint()
                    "configure" -> { core.configure(args.requireText("url")); null }
                    "login" -> core.login(args.requireText("username"), args.requireText("password"))
                    "authenticationOptions" -> core.authenticationOptions()
                    "logout" -> { core.logout(); null }
                    "refresh" -> { core.refresh(); null }
                    "sync" -> { core.sync(); null }
                    "createDraft" -> core.createDraft(args.requireText("scopeId"), category = args.optString("category", "inbox"), replyTarget = args.optJSONObject("replyTarget")).json()
                    "saveDraft" -> core.saveDraft(args.requireText("draftId"), args.requireText("text"), args.requireText("scopeId"), if (args.has("expectedRevision")) args.getInt("expectedRevision") else null, if (args.has("secure")) args.getBoolean("secure") else null).json()
                    "discardDraft" -> { core.discardDraft(args.requireText("draftId")); null }
                    "submitDraft" -> { core.submitDraft(args.requireText("draftId"), if (args.has("requestWork")) args.getBoolean("requestWork") else null); null }
                    "suggestionMessages" -> core.suggestionMessages(args.requireText("suggestionId"), args.getLong("beforeSequence"))
                    "addPhoto" -> core.addPhoto(args.requireText("draftId"), Base64.decode(args.requireText("base64"), Base64.DEFAULT), args.requireText("mimeType")).json()
                    "removePhoto" -> core.removePhoto(args.requireText("draftId"), args.requireText("mediaId")).json()
                    "copyRejectedDraft" -> core.copyRejected(args.requireText("draftId")).json()
                    "openAttachmentDraft" -> core.openAttachmentDraft(args.requireText("recordId"), args.requireText("scopeId"), args.getInt("revision"), args.getJSONArray("attachments")).json()
                    "readAttachmentDraft" -> core.attachmentDrafts.read(core.clientId(), args.requireText("draftId")).json()
                    "saveAttachmentDraft" -> core.saveAttachmentDraft(args.requireText("draftId"), args.getInt("revision"), args.getJSONArray("attachments")).json()
                    "discardAttachmentDraft" -> { core.discardAttachmentDraft(args.requireText("draftId")); null }
                    "addAttachmentPhoto" -> core.addAttachmentPhoto(args.requireText("draftId"), Base64.decode(args.requireText("base64"), Base64.DEFAULT), args.requireText("mimeType")).json()
                    "submitAttachmentDraft" -> core.submitAttachmentDraft(args.requireText("draftId"))
                    "photoPath" -> core.photoPath(args.requireText("mediaId"), args.optJSONObject("descriptor"))
                    "command" -> core.command(args.requireText("recordId"), args.requireText("kind"), args.getJSONObject("arguments"), args.requireText("expectedServerEpoch"))
                    "history" -> core.history(args.requireText("recordId"))
                    "shoppingHistory" -> core.shoppingHistory(args.requireText("recordId"))
                    "sharingPreview" -> core.sharingPreview(args.requireText("recordId"))
                    "recordSecurity" -> core.recordSecurity(args.requireText("recordId"), args.optJSONObject("request"))
                    "shoppingSettings" -> core.shoppingSettings(if (args.has("preferences")) args else null)
                    "filingAdviceSettings" -> core.filingAdviceSettings()
                    "saveFilingAdviceSettings" -> core.saveFilingAdviceSettings(args.getLong("expectedRevision"), args.getJSONObject("preferences"))
                    "filingAdvice" -> core.filingAdvice(args.requireText("inboxId"), args.optJSONObject("request"))
                    "recordHistory" -> core.recordHistory(args.requireText("recordId"))
                    "recipeImport" -> core.recipeImport(args.requireText("importId"))
                    "saveEditor" -> { core.saveEditor(args.requireText("recordId"), args.requireText("text"), args.getInt("baseRevision"), args.requireText("serverEpoch")); null }
                    "readEditor" -> core.readEditor(args.requireText("recordId"))
                    "clearEditor" -> { core.clearEditor(args.requireText("recordId")); null }
                    "storage" -> core.storage()
                    "localStorage" -> core.localStorage()
                    "backups" -> core.backups()
                    "createBackup" -> { core.createBackup(); null }
                    "recoverDraft" -> core.recoverDraft(args.requireText("draftId"))?.json()
                    "reconcileEdits" -> { core.reconcileEdits(); null }
                    "acquirePhoto" -> {
                        val draft = core.captures.draft(core.clientId(), args.requireText("draftId")); check(draft.state == "DRAFT") { "draft_locked" }
                        val mode = args.requireText("mode"); require(mode in listOf("camera", "gallery"))
                        activity.runOnUiThread { activity.startActivity(Intent(activity, PhotoCaptureActivity::class.java).putExtra("draftId", draft.draftId).putExtra("mode", mode)) }; null
                    }
                    "acquireAttachmentPhoto" -> {
                        val draft = core.attachmentDrafts.read(core.clientId(), args.requireText("draftId")); check(draft.state == "DRAFT") { "draft_locked" }
                        val mode = args.requireText("mode"); require(mode in listOf("camera", "gallery"))
                        activity.runOnUiThread { activity.startActivity(Intent(activity, PhotoCaptureActivity::class.java).putExtra("draftId", draft.draftId).putExtra("mode", mode).putExtra("targetKind", "record")) }; null
                    }
                    "dictate" -> { core.requireSession(); val category = args.optString("category", "inbox"); require(category in listOf("inbox", "app_suggestion")); activity.runOnUiThread { activity.startActivity(Intent(activity, QuickCaptureActivity::class.java).putExtra("voice", true).putExtra("category", category)) }; null }
                    else -> error("unsupported_client_method")
                }
                call.resolve(JSObject().put("value", result ?: JSONObject.NULL))
            } catch (error: Exception) { call.reject(error.message ?: "native_operation_failed") }
        }
    }
}

private fun JSONObject.requireText(key: String): String = (get(key) as? String) ?: error("invalid_$key")
