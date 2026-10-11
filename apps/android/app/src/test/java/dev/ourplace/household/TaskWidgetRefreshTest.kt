package dev.ourplace.household

import android.content.Context
import android.view.View
import android.widget.LinearLayout
import android.widget.TextView
import androidx.test.core.app.ApplicationProvider
import dev.ourplace.household.platform.ApiException
import dev.ourplace.household.widgets.*
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class TaskWidgetRefreshTest {
    @Test fun networkFailureIsVisibleAndNextAttemptDownloadsAndClearsIt() {
        val context = ApplicationProvider.getApplicationContext<Context>()
        val phases = mutableListOf<String>()
        var attempts = 0
        TaskWidgetRefreshWorker.refresh(context, {
            attempts++
            assertEquals("Refreshing…", TaskWidgetRefreshWorker.feedback(context))
            throw ApiException("server_unreachable")
        }, { phases.add(TaskWidgetRefreshWorker.feedback(context)) })
        assertEquals(listOf("Refreshing…", "Unreachable"), phases)
        val view = TaskWidget.views(context, 1, TaskWidgetView("Our place", "", sampledAt = 1000), null)
            .apply(context, LinearLayout(context))
        assertEquals("Unreachable", view.findViewById<TextView>(R.id.widget_sampled).text.toString())
        assertTrue(view.findViewById<View>(R.id.widget_refresh).contentDescription.contains("Tailscale"))
        TaskWidgetRefreshWorker.refresh(context, { attempts++ }, { phases.add(TaskWidgetRefreshWorker.feedback(context)) })
        assertEquals(2, attempts)
        assertEquals(listOf("Refreshing…", "Unreachable", "Refreshing…", ""), phases)
        val refreshed = TaskWidget.views(context, 1, TaskWidgetView("Our place", "", sampledAt = 1000), null)
            .apply(context, LinearLayout(context))
        assertNotEquals("Unreachable", refreshed.findViewById<TextView>(R.id.widget_sampled).text.toString())
    }

    @Test fun expiredProgressAndAuthenticationFailuresHaveRecoveryPaths() {
        val context = ApplicationProvider.getApplicationContext<Context>()
        TaskWidgetRefreshWorker.refresh(context, { throw ApiException("session_expired", 401) }, {})
        assertEquals("Open app", TaskWidgetRefreshWorker.feedback(context))
        assertEquals("", TaskWidgetRefreshWorker.feedback(context, System.currentTimeMillis() + 121_000))
    }
}
