package dev.ourplace.household.widgets

import android.content.Intent
import dev.ourplace.household.ClientCore
import dev.ourplace.household.storage.ValueRow
import org.json.JSONObject
import java.util.UUID

/** An intent requests an in-app view; it cannot submit a command or select another profile. */
object WidgetNavigation {
    const val ACTION = "dev.ourplace.household.OPEN_TASK_WIDGET"
    private const val KEY = "task-widget-navigation"
    fun accept(core: ClientCore, intent: Intent?) {
        if (intent?.action != ACTION) return
        val clientId = intent.getStringExtra("clientId") ?: return
        val serverEpoch = intent.getStringExtra("serverEpoch") ?: return
        val recordId = intent.getStringExtra("recordId") ?: return
        val action = intent.getStringExtra("taskAction") ?: return
        if (action !in listOf("show", "complete", "postpone") ||
            listOf(clientId, serverEpoch, recordId).any { it.length !in 1..160 }) return
        // Prevent configuration recreation from replaying an already-consumed launch intent.
        intent.action = Intent.ACTION_MAIN
        val value = JSONObject().put("token", UUID.randomUUID().toString()).put("clientId", clientId)
            .put("serverEpoch", serverEpoch).put("recordId", recordId).put("action", action)
        core.db.dao().putValue(ValueRow(KEY, value.toString()))
        core.changed()
    }
    fun take(core: ClientCore): JSONObject? = core.db.runInTransaction(java.util.concurrent.Callable {
        val value = core.db.dao().value(KEY) ?: return@Callable null
        core.db.dao().deleteValue(KEY)
        JSONObject(value)
    })
}
