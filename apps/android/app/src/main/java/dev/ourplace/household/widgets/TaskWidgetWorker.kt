package dev.ourplace.household.widgets

import android.content.Context
import androidx.work.*
import dev.ourplace.household.ClientCore
import java.util.concurrent.TimeUnit

class TaskWidgetWorker(context: Context, params: WorkerParameters) : Worker(context, params) {
    override fun doWork(): Result {
        if (TaskWidget.ids(applicationContext).isEmpty()) return Result.success()
        return try { ClientCore.get(applicationContext).sync(); Result.success() }
        catch (_: Exception) { TaskWidget.refreshAll(applicationContext); Result.retry() }
    }
    companion object {
        fun schedule(context: Context) {
            val work = PeriodicWorkRequestBuilder<TaskWidgetWorker>(30, TimeUnit.MINUTES)
                .setConstraints(Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build()).build()
            WorkManager.getInstance(context).enqueueUniquePeriodicWork("refresh-task-widgets", ExistingPeriodicWorkPolicy.KEEP, work)
        }
        fun cancel(context: Context) { WorkManager.getInstance(context).cancelUniqueWork("refresh-task-widgets") }
    }
}
