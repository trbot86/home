package dev.ourplace.household.widgets

import org.json.JSONObject
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId
import java.time.format.DateTimeFormatter

/** Civil dates and exclusive event ends match Agenda. This cached view never writes data. */
internal object WidgetCalendar {
    fun read(agenda: JSONObject?, data: JSONObject, allowed: Set<String>, options: TaskWidgetOptions): Pair<List<TaskWidgetItem>, String> {
        if (!data.has("calendarTasks")) return emptyList<TaskWidgetItem>() to "Refresh app for calendar."
        val start = LocalDate.parse(data.getString("date"))
        val zone = ZoneId.of(data.getString("timeZone"))
        val entries = mutableListOf<Triple<String, Long, TaskWidgetItem>>()
        fun visible(row: JSONObject) = row.getString("scopeId") in allowed &&
            (options.context == "both" || row.getString("context") == options.context)
        val tasks = data.getJSONArray("calendarTasks")
        for (i in 0 until tasks.length()) {
            val task = tasks.getJSONObject(i)
            if (!visible(task)) continue
            val day = LocalDate.parse(task.getString("day"))
            if (day < start || day >= start.plusDays(7)) continue
            val title = (if (task.getBoolean("completed")) "✓ " else "") + task.getString("title")
            entries.add(Triple(day.toString(), Long.MIN_VALUE, TaskWidgetItem("", task.getString("occurrenceId"), title, "$day · Task", WidgetDate.badge(day, start), day == start)))
        }
        val calendars = agenda?.optJSONArray("calendars")
        var stale = agenda == null || agenda.optBoolean("needsReconnect")
        for (i in 0 until (calendars?.length() ?: 0)) {
            val calendar = calendars!!.getJSONObject(i)
            if (!visible(calendar)) continue
            stale = stale || !calendar.isNull("errorCode") || calendar.isNull("refreshedAt")
            val events = calendar.getJSONArray("events")
            for (j in 0 until events.length()) {
                val event = events.getJSONObject(j)
                if (!options.includePrivate && event.optString("visibility") in listOf("private", "confidential")) continue
                val timing = event.getJSONObject("timing")
                val allDay = timing.getString("kind") == "all_day"
                val instant = if (allDay) 0L else timing.getLong("startAt")
                val first = if (allDay) LocalDate.parse(timing.getString("startDate")) else Instant.ofEpochMilli(instant).atZone(zone).toLocalDate()
                val last = if (allDay) LocalDate.parse(timing.getString("endDate")).minusDays(1)
                    else Instant.ofEpochMilli(maxOf(instant, timing.getLong("endAt") - 1)).atZone(zone).toLocalDate()
                for (offset in 0L..6L) {
                    val day = start.plusDays(offset)
                    if (day < first || day > last) continue
                    val time = if (allDay) "All day" else if (day > first) "Continues" else
                        DateTimeFormatter.ofPattern("HH:mm").format(Instant.ofEpochMilli(instant).atZone(zone))
                    val status = if (event.optString("participation") == "declined") " · Declined" else ""
                    val shortTime = if (allDay || day > first) null else
                        DateTimeFormatter.ofPattern("h:mma", java.util.Locale.ENGLISH).format(Instant.ofEpochMilli(instant).atZone(zone))
                            .lowercase(java.util.Locale.ENGLISH).replace("am", "a").replace("pm", "p")
                    val badge = WidgetDate.badge(day, start, shortTime) +
                        (if (day != start && shortTime != null) "\n$shortTime" else "")
                    entries.add(Triple(day.toString(), if (allDay) Long.MIN_VALUE else instant,
                        TaskWidgetItem("", "", event.getString("title") + status, "$day · $time$status", badge, day == start)))
                }
            }
        }
        val items = entries.sortedWith(compareBy({ it.first }, { it.second }, { it.third.title })).map { it.third }
        return items to when {
            stale -> "Calendar needs refresh in app."
            items.isEmpty() -> "No entries in next 7 days."
            else -> ""
        }
    }
}
