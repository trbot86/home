package dev.ourplace.household.widgets

import android.content.Context
import androidx.work.*
import dev.ourplace.household.ClientCore
import dev.ourplace.household.platform.ApiException

/** A user-requested download must not wait behind capture-upload retries. */
class TaskWidgetRefreshWorker(context: Context, params: WorkerParameters) : Worker(context, params) {
    override fun doWork(): Result {
        refresh(applicationContext, { ClientCore.get(applicationContext).refresh() })
        // A failed manual attempt remains visible. The next tap starts a fresh attempt;
        // periodic refresh and the durable capture queue retain their own retry policies.
        return Result.success()
    }

    companion object {
        internal const val WORK_NAME = "manual-task-widget-refresh"
        private const val PREFERENCES = "task-widget-refresh"
        private const val MAX_STATUS_AGE = 120_000L

        private fun status(context: Context, value: String) {
            context.getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE).edit()
                .putString("status", value).putLong("at", System.currentTimeMillis()).apply()
        }

        internal fun feedback(context: Context, now: Long = System.currentTimeMillis()): String {
            val values = context.getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE)
            val age = now - values.getLong("at", 0)
            return if (age in 0..MAX_STATUS_AGE) values.getString("status", "") ?: "" else ""
        }

        fun request(context: Context) {
            status(context, "Refreshing…")
            TaskWidget.refreshAll(context)
            try {
                // No CONNECTED constraint: attempt now, including after VPN reconnection,
                // and report failure instead of silently waiting for a network constraint.
                WorkManager.getInstance(context).enqueueUniqueWork(WORK_NAME, ExistingWorkPolicy.KEEP,
                    OneTimeWorkRequestBuilder<TaskWidgetRefreshWorker>().build())
            } catch (_: Exception) {
                status(context, "Try again")
                TaskWidget.refreshAll(context)
            }
        }

        internal fun refresh(context: Context, download: () -> Unit, redraw: () -> Unit = { TaskWidget.refreshAll(context) }) {
            status(context, "Refreshing…")
            redraw()
            try {
                download()
                status(context, "")
            } catch (error: Exception) {
                status(context, when {
                    error is ApiException && error.status == 0 -> "Unreachable"
                    error is ApiException && error.status == 401 -> "Open app"
                    else -> "Try again"
                })
            } finally {
                redraw()
            }
        }
    }
}
