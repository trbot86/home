package dev.ourplace.household.capture

import android.Manifest
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.service.quicksettings.TileService
import androidx.core.content.ContextCompat

class CaptureTile : TileService() {
    override fun onClick() {
        val lockedAllowed=Build.VERSION.SDK_INT >= 27 && allowLocked(this) && ContextCompat.checkSelfPermission(this,Manifest.permission.RECORD_AUDIO)==PackageManager.PERMISSION_GRANTED
        if (isLocked && !lockedAllowed) unlockAndRun { launchCapture(false) }
        else launchCapture(isLocked && lockedAllowed)
    }
    @Suppress("DEPRECATION")
    private fun launchCapture(locked: Boolean) {
        val intent=captureIntent(this,locked)
        if (Build.VERSION.SDK_INT >= 34) startActivityAndCollapse(PendingIntent.getActivity(this,0,intent,PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE))
        else startActivityAndCollapse(intent)
    }
    companion object {
        fun allowLocked(context: Context)=context.getSharedPreferences("capture-tile",Context.MODE_PRIVATE).getBoolean("allowLocked",false)
        fun setAllowLocked(context: Context, enabled: Boolean) { check(context.getSharedPreferences("capture-tile",Context.MODE_PRIVATE).edit().putBoolean("allowLocked",enabled).commit()) }
        fun captureIntent(context: Context, locked: Boolean)=Intent(context,if(locked) LockedCaptureActivity::class.java else QuickCaptureActivity::class.java)
            .putExtra("voice",true).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_MULTIPLE_TASK)
    }
}

/** Separate, non-exported activity: no old app task or cached household content above keyguard. */
class LockedCaptureActivity : QuickCaptureActivity() {
    override val lockScreenCapture = true
}
