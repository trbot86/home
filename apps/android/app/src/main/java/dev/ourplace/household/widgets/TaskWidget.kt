package dev.ourplace.household.widgets

import android.app.PendingIntent
import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProvider
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.os.Build
import android.util.SizeF
import android.view.View
import android.widget.RemoteViews
import dev.ourplace.household.ClientCore
import dev.ourplace.household.MainActivity
import dev.ourplace.household.R
import dev.ourplace.household.capture.QuickCaptureActivity
import dev.ourplace.household.sync.UploadWorker
import java.text.DateFormat
import java.util.Date
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean

class TaskWidget : AppWidgetProvider() {
    override fun onUpdate(context: Context, manager: AppWidgetManager, ids: IntArray) {
        refreshAll(context); TaskWidgetWorker.schedule(context); UploadWorker.schedule(context)
    }
    override fun onAppWidgetOptionsChanged(context: Context, manager: AppWidgetManager, id: Int, options: Bundle) { refreshAll(context) }
    override fun onDeleted(context: Context, ids: IntArray) { ids.forEach { TaskWidgetSettings(context).delete(it) } }
    override fun onDisabled(context: Context) { TaskWidgetWorker.cancel(context) }
    override fun onReceive(context: Context, intent: Intent) {
        super.onReceive(context, intent)
        if (intent.action == REFRESH && ids(context).isNotEmpty()) {
            refreshAll(context); TaskWidgetWorker.schedule(context); UploadWorker.schedule(context)
        }
    }
    companion object {
        const val REFRESH = "dev.ourplace.household.REFRESH_TASK_WIDGET"
        private val publisher = Any()
        private val rendering = AtomicBoolean(false)
        private val dirty = AtomicBoolean(false)
        private val executor = Executors.newSingleThreadExecutor()
        fun ids(context: Context): IntArray = AppWidgetManager.getInstance(context).getAppWidgetIds(ComponentName(context, TaskWidget::class.java))
        fun refreshAll(context: Context) {
            if (ids(context).isEmpty()) return
            dirty.set(true)
            if (!rendering.compareAndSet(false, true)) return
            executor.execute {
                try {
                    do {
                        dirty.set(false)
                        synchronized(publisher) {
                            try { renderAll(context, ClientCore.get(context)) }
                            catch (_: Exception) {
                                // Publish no cached titles after a failed read, especially during a profile change.
                                val manager = AppWidgetManager.getInstance(context)
                                for (id in ids(context)) runCatching {
                                    manager.updateAppWidget(id, shell(context, id, "Our place", "Open the app to refresh this widget."))
                                }
                            }
                        }
                    } while (dirty.get())
                } finally { rendering.set(false); if (dirty.get()) refreshAll(context) }
            }
        }
        /** Serialize profile publication with widget rendering so a late render cannot reveal the former profile. */
        fun <T> profileChange(context: Context, change: () -> T): T = synchronized(publisher) {
            val manager = AppWidgetManager.getInstance(context)
            for (id in ids(context)) manager.updateAppWidget(id, shell(context, id, "Our place", "Open the app to load this profile."))
            change()
        }
        private fun activity(context: Context, id: Int, key: String, intent: Intent): PendingIntent {
            intent.data = Uri.Builder().scheme("ourplace-widget").authority("tasks").appendPath(id.toString()).appendPath(key).build()
            return PendingIntent.getActivity(context, 0, intent, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
        }
        private fun shell(context: Context, id: Int, heading: String, message: String) = RemoteViews(context.packageName, R.layout.task_widget).apply {
            setTextViewText(R.id.widget_title, heading)
            setTextViewText(R.id.widget_message, message)
            setViewVisibility(R.id.widget_message, if (message.isBlank()) View.GONE else View.VISIBLE)
            setViewVisibility(R.id.widget_capture, View.GONE)
            setOnClickPendingIntent(R.id.widget_title, activity(context, id, "open", Intent(context, MainActivity::class.java)))
            setOnClickPendingIntent(R.id.widget_more, activity(context, id, "open", Intent(context, MainActivity::class.java)))
            setOnClickPendingIntent(R.id.widget_settings, activity(context, id, "settings", Intent(context, TaskWidgetConfiguration::class.java).putExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, id)))
            setOnClickPendingIntent(R.id.widget_capture, activity(context, id, "capture", Intent(context, QuickCaptureActivity::class.java).putExtra("voice", true)))
            val refresh = PendingIntent.getBroadcast(context, id, Intent(context, TaskWidget::class.java).setAction(REFRESH), PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
            setOnClickPendingIntent(R.id.widget_refresh, refresh)
        }
        fun renderAll(context: Context, core: ClientCore) {
            val manager = AppWidgetManager.getInstance(context)
            val state = core.widgetState()
            for (id in ids(context)) {
                val options = TaskWidgetSettings(context).read(id)
                fun forRows(count: Int, wide: Boolean) = views(context, id, TaskWidgetModel.render(state, options, count), options, wide)
                val responsive = if (Build.VERSION.SDK_INT >= 31) {
                    // Let the launcher select a layout for its actual bounds, including rotations and foldables.
                    RemoteViews(listOf(220f, 320f).flatMap { width -> (0..5).map { count ->
                        SizeF(width, 132f + 52f * count) to forRows(count, width >= 320f) } }.toMap())
                } else {
                    val bounds = manager.getAppWidgetOptions(id)
                    fun forBounds(height: String, width: String) = forRows(capacityForHeight(bounds.getInt(height, 320)), bounds.getInt(width, 220) >= 320)
                    RemoteViews(forBounds(AppWidgetManager.OPTION_APPWIDGET_MIN_HEIGHT, AppWidgetManager.OPTION_APPWIDGET_MAX_WIDTH),
                        forBounds(AppWidgetManager.OPTION_APPWIDGET_MAX_HEIGHT, AppWidgetManager.OPTION_APPWIDGET_MIN_WIDTH))
                }
                manager.updateAppWidget(id, responsive)
            }
        }
        internal fun capacityForHeight(height: Int): Int = ((height - 132) / 52).coerceIn(0, 5)

        internal fun views(context: Context, id: Int, model: TaskWidgetView, options: TaskWidgetOptions?, wide: Boolean = false): RemoteViews {
                val views = shell(context, id, model.heading, if (wide && model.calendar.isNotEmpty()) "" else model.message)
                views.setViewVisibility(R.id.widget_calendar_column, if (wide && model.ready) View.VISIBLE else View.GONE)
                views.removeAllViews(R.id.widget_calendar_items)
                views.setViewVisibility(R.id.widget_capture, if (model.ready) View.VISIBLE else View.GONE)
                // The smallest layout has room for either the timestamp or the resize hint.
                views.setViewVisibility(R.id.widget_sampled, if (model.ready && model.total > 0 && model.items.isEmpty()) View.GONE else View.VISIBLE)
                views.setTextViewText(R.id.widget_sampled, model.sampledAt?.let {
                    "Downloaded " + DateFormat.getDateTimeInstance(DateFormat.SHORT, DateFormat.SHORT).format(Date(it))
                } ?: "")
                views.setTextViewText(R.id.widget_more, if (model.total > model.items.size) "Agenda · ${model.total - model.items.size} more" else if (model.ready) "Open Agenda" else "Open app")
                if (model.ready && options != null) {
                    val agenda = Intent(context, MainActivity::class.java).setAction(WidgetNavigation.ACTION)
                        .putExtra("clientId", options.clientId).putExtra("serverEpoch", options.serverEpoch)
                        .putExtra("taskAction", "agenda")
                    val pending = activity(context, id, "${options.clientId}/${options.serverEpoch}/agenda", agenda)
                    views.setOnClickPendingIntent(R.id.widget_title, pending)
                    views.setOnClickPendingIntent(R.id.widget_more, pending)
                    views.setOnClickPendingIntent(R.id.widget_calendar_heading, pending)
                    views.setOnClickPendingIntent(R.id.widget_tasks_heading, pending)
                    if (wide) {
                        views.setTextViewText(R.id.widget_more, "Open Agenda")
                        views.setTextViewText(R.id.widget_tasks_heading, if (model.total > model.items.size)
                            "Tasks · +${model.total - model.items.size}" else "Tasks")
                        views.setTextViewText(R.id.widget_calendar_heading, if (model.calendarMessage.contains("refresh", ignoreCase = true)) "Calendar · refresh" else if (model.calendarTotal > model.calendar.size)
                            "Calendar · +${model.calendarTotal - model.calendar.size}" else "Calendar · 7 days")
                        for (item in model.calendar) {
                            val row = RemoteViews(context.packageName, R.layout.task_widget_row)
                            row.setTextViewText(R.id.widget_item_title, item.title)
                            row.setTextViewText(R.id.widget_item_detail, item.detail)
                            row.setViewVisibility(R.id.widget_done, View.GONE)
                            row.setViewVisibility(R.id.widget_move, View.GONE)
                            row.setOnClickPendingIntent(R.id.widget_item_title, pending)
                            row.setOnClickPendingIntent(R.id.widget_item_detail, pending)
                            views.addView(R.id.widget_calendar_items, row)
                        }
                        if (model.calendarMessage.isNotEmpty() && model.calendar.size < minOf(options.limit, model.capacity)) {
                            val row = RemoteViews(context.packageName, R.layout.task_widget_row)
                            row.setTextViewText(R.id.widget_item_title, model.calendarMessage)
                            row.setViewVisibility(R.id.widget_item_detail, View.GONE)
                            row.setViewVisibility(R.id.widget_done, View.GONE)
                            row.setViewVisibility(R.id.widget_move, View.GONE)
                            row.setOnClickPendingIntent(R.id.widget_item_title, pending)
                            views.addView(R.id.widget_calendar_items, row)
                        }
                    }
                }
                views.removeAllViews(R.id.widget_items)
                if (model.ready && options != null) for (item in model.items) {
                    val row = RemoteViews(context.packageName, R.layout.task_widget_row)
                    row.setTextViewText(R.id.widget_item_title, item.title)
                    if (wide) {
                        row.setViewVisibility(R.id.widget_done, View.GONE)
                        row.setViewVisibility(R.id.widget_move, View.GONE)
                    }
                    row.setTextViewText(R.id.widget_item_detail, item.detail)
                    for ((viewId, action) in listOf(R.id.widget_item_title to "show", R.id.widget_done to "complete", R.id.widget_move to "postpone")) {
                        val intent = Intent(context, MainActivity::class.java).setAction(WidgetNavigation.ACTION)
                            .putExtra("clientId", options.clientId).putExtra("serverEpoch", options.serverEpoch)
                            .putExtra("recordId", item.occurrenceId).putExtra("taskAction", action)
                        row.setOnClickPendingIntent(viewId, activity(context, id, "${options.clientId}/${options.serverEpoch}/${item.occurrenceId}/$action", intent))
                    }
                    views.addView(R.id.widget_items, row)
                }
                return views
        }
    }
}
