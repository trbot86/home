package dev.ourplace.household.widgets

import org.json.JSONObject

data class TaskWidgetOptions(val clientId: String, val personId: String, val serverEpoch: String,
    val context: String = "both", val includePrivate: Boolean = false, val focusOnly: Boolean = false, val limit: Int = 3) {
    init { require(context in listOf("both", "home", "work") && limit in 1..5) }
    fun json() = JSONObject().put("version", 1).put("clientId", clientId).put("personId", personId)
        .put("serverEpoch", serverEpoch).put("context", context).put("includePrivate", includePrivate)
        .put("focusOnly", focusOnly).put("limit", limit)
    companion object {
        fun read(text: String?): TaskWidgetOptions? = try {
            text?.let { JSONObject(it) }?.let { value ->
                require(value.getInt("version") == 1)
                TaskWidgetOptions(value.getString("clientId"), value.getString("personId"), value.getString("serverEpoch"),
                    value.getString("context"), value.getBoolean("includePrivate"), value.getBoolean("focusOnly"), value.getInt("limit"))
            }
        } catch (_: Exception) { null }
    }
}
data class TaskWidgetItem(val taskId: String, val occurrenceId: String, val title: String, val detail: String)
data class TaskWidgetView(val heading: String, val message: String, val sampledAt: Long? = null,
    val items: List<TaskWidgetItem> = emptyList(), val total: Int = 0, val ready: Boolean = false)

/** Filtering only: ordering and deadline/target classification come from the shared server read model. */
object TaskWidgetModel {
    fun render(state: JSONObject, options: TaskWidgetOptions?, capacity: Int): TaskWidgetView {
        if (options == null) return TaskWidgetView("Our place", "Tap Settings to choose your task view.")
        val session = state.optJSONObject("session")
        if (session == null || session.optString("clientId") != options.clientId ||
            session.optJSONObject("person")?.optString("personId") != options.personId)
            return TaskWidgetView("Our place", "Open the app with this widget’s profile.")
        if (state.optBoolean("recoveryRequired") || session.optString("serverEpoch") != options.serverEpoch)
            return TaskWidgetView("Our place", "Open the app to check recovery, then set up this widget again.")
        val heading = session.getJSONObject("person").getString("displayName") + " · Tasks"
        val data = state.optJSONObject("taskWidget")
        if (data == null || data.optInt("version") != 1 || data.optString("personId") != options.personId)
            return TaskWidgetView(heading, "Open the app and refresh to load tasks.")
        return try {
            val scopes = session.getJSONArray("scopes")
            val allowed = (0 until scopes.length()).map { scopes.getJSONObject(it) }
                .filter { it.getString("kind") == "shared" || options.includePrivate && it.getString("kind") == "private" }
                .map { it.getString("scopeId") }.toSet()
            val rows = data.getJSONArray("rows")
            require(rows.length() <= 2000)
            val items = (0 until rows.length()).map { rows.getJSONObject(it) }.filter {
                it.getString("scopeId") in allowed && (options.context == "both" || it.getString("context") == options.context) &&
                    (!options.focusOnly || it.getString("attention") !in listOf("anytime", "upcoming"))
            }.map {
                val attention = it.getString("attention")
                require(attention in listOf("overdue", "today", "priority", "ready", "review", "upcoming", "anytime"))
                fun date(key: String) = if (it.isNull(key)) null else it.getString(key)
                val detail = when {
                    attention == "overdue" -> "Past deadline · " + date("deadlineDate")
                    attention == "today" -> "Deadline today"
                    attention == "priority" -> "Important"
                    date("reviewDate") != null && attention == "review" -> "Revisit · " + date("reviewDate")
                    date("targetDate") != null && attention == "ready" -> "Aim for · " + date("targetDate")
                    date("deadlineDate") != null -> "Deadline · " + date("deadlineDate")
                    date("targetDate") != null -> "Aim for · " + date("targetDate")
                    date("reviewDate") != null -> "Revisit · " + date("reviewDate")
                    else -> "Without a date"
                }
                TaskWidgetItem(it.getString("taskId"), it.getString("occurrenceId"), it.getString("title"), detail)
            }
            val sampledAt = data.getLong("sampledAt")
            require(sampledAt > 0 && sampledAt == state.getLong("sampledAt"))
            val message = when {
                items.isEmpty() && options.focusOnly -> "No tasks need attention in this view. Turn off Focus in Settings to see upcoming and undated tasks."
                items.isEmpty() -> "Nothing in this view. Check Settings or open Tasks for everything."
                capacity <= 0 -> "Resize to see tasks."
                else -> ""
            }
            TaskWidgetView(heading, message,
                sampledAt, items.take(minOf(options.limit, capacity.coerceIn(0, 5))), items.size, true)
        } catch (_: Exception) { TaskWidgetView(heading, "Open the app and refresh to load tasks.") }
    }
}
