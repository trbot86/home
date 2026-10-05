package dev.ourplace.household.widgets

import java.time.LocalDate
import java.time.format.DateTimeFormatter
import java.util.Locale

internal object WidgetDate {
    fun badge(day: LocalDate?, today: LocalDate, time: String? = null): String = when {
        day == null -> ""
        day == today -> time ?: "TODAY"
        day < today -> "LATE"
        day <= today.plusDays(7) -> day.format(DateTimeFormatter.ofPattern("EEE", Locale.ENGLISH)).uppercase(Locale.ENGLISH)
        else -> day.format(DateTimeFormatter.ofPattern(if (day.year == today.year) "MMM d" else "MMM d yy", Locale.ENGLISH))
    }
}
