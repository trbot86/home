package dev.ourplace.household

import android.content.Context
import android.content.Intent
import androidx.test.core.app.ApplicationProvider
import dev.ourplace.household.capture.*
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class CaptureTileTest {
    @Test fun lockScreenCaptureRequiresOptInAndUsesFreshIsolatedActivity() {
        val context=ApplicationProvider.getApplicationContext<Context>()
        CaptureTile.setAllowLocked(context,false)
        assertFalse(CaptureTile.allowLocked(context))
        CaptureTile.setAllowLocked(context,true)
        assertTrue(CaptureTile.allowLocked(context))
        val locked=CaptureTile.captureIntent(context,true)
        assertEquals(LockedCaptureActivity::class.java.name,locked.component!!.className)
        assertTrue(locked.flags and Intent.FLAG_ACTIVITY_MULTIPLE_TASK != 0)
        assertTrue(locked.getBooleanExtra("voice",false))
        assertFalse(locked.hasExtra("draftId"))
        val info=context.packageManager.getActivityInfo(locked.component!!,0)
        assertFalse(info.exported)
        assertEquals("dev.ourplace.household.lockedcapture",info.taskAffinity)
        assertEquals(QuickCaptureActivity::class.java.name,CaptureTile.captureIntent(context,false).component!!.className)
    }
}
