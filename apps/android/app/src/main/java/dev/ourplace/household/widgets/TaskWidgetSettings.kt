package dev.ourplace.household.widgets

import android.content.Context

/** Only presentation preferences; household content remains in the existing Room cache. */
class TaskWidgetSettings(context: Context) {
    private val preferences = context.getSharedPreferences("task-widgets", Context.MODE_PRIVATE)
    fun read(id: Int) = TaskWidgetOptions.read(preferences.getString(id.toString(), null))
    fun save(id: Int, options: TaskWidgetOptions) { check(preferences.edit().putString(id.toString(), options.json().toString()).commit()) }
    fun delete(id: Int) { check(preferences.edit().remove(id.toString()).commit()) }
}
