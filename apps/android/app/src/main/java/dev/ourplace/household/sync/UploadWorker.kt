package dev.ourplace.household.sync

import android.content.Context
import androidx.work.*
import dev.ourplace.household.ClientCore
import dev.ourplace.household.platform.ApiException
import java.util.concurrent.TimeUnit

class UploadWorker(context: Context, params: WorkerParameters) : Worker(context, params) {
    override fun doWork(): Result = try { ClientCore.get(applicationContext).sync(); Result.success() }
        catch (error: ApiException) { if (error.status == 401) Result.failure() else Result.retry() }
        catch (_: Exception) { Result.retry() }
    companion object {
        fun schedule(context: Context) {
            val request = OneTimeWorkRequestBuilder<UploadWorker>().setConstraints(Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build())
                .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 15, TimeUnit.SECONDS).build()
            WorkManager.getInstance(context).enqueueUniqueWork("drain-household-captures", ExistingWorkPolicy.APPEND_OR_REPLACE, request)
        }
    }
}
