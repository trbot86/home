package dev.ourplace.household.widgets

import android.Manifest
import android.app.StatusBarManager
import android.app.PendingIntent
import android.content.Intent
import android.appwidget.AppWidgetManager
import android.content.ComponentName
import android.content.pm.PackageManager
import android.graphics.drawable.Icon
import android.os.Build
import android.os.Bundle
import android.widget.*
import androidx.activity.ComponentActivity
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.content.ContextCompat
import dev.ourplace.household.R
import dev.ourplace.household.capture.CaptureWidget
import dev.ourplace.household.capture.CaptureTile

class WidgetSetupActivity : ComponentActivity() {
    private lateinit var status: TextView
    private val permission = registerForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        status.text = if (granted) "Microphone ready. Try the capture widget or tile." else "Microphone permission is off. Capture still supports typing."
    }
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val pad = (20 * resources.displayMetrics.density).toInt()
        val layout = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setPadding(pad,pad*2,pad,pad); setBackgroundColor(getColor(R.color.household_background)) }
        fun label(text: String) = TextView(this).apply { this.text=text; textSize=16f; setTextColor(getColor(R.color.household_accent)); setPadding(0,pad/2,0,pad/2); layout.addView(this) }
        fun button(text: String, action: () -> Unit) { layout.addView(Button(this).apply { this.text=text; setOnClickListener { action() } }) }
        label("Android widgets").textSize=24f
        label("Voice capture saves a new private inbox note for the profile currently selected in Our place. It reads back the recognized text and queues it locally if offline.")
        status=label("")
        fun pin(type: Class<*>) {
            val manager=AppWidgetManager.getInstance(this)
            // Pinning bypasses the launcher's initial configuration flow. Publish the
            // neutral task-widget shell so its Settings action is immediately usable.
            val callback = if (type == TaskWidget::class.java) PendingIntent.getBroadcast(this,0,
                Intent(this,TaskWidget::class.java).setAction(TaskWidget.REFRESH),PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE) else null
            status.text=if (Build.VERSION.SDK_INT >= 26 && manager.isRequestPinAppWidgetSupported && manager.requestPinAppWidget(ComponentName(this,type),null,callback))
                "Confirm Add in your launcher. On the task widget, tap Settings to choose your profile and task view."
                else "Long-press an empty home-screen area, choose Widgets, then Our place."
        }
        button("Add voice capture widget") { pin(CaptureWidget::class.java) }
        button("Enable microphone") { permission.launch(Manifest.permission.RECORD_AUDIO) }
        label("The tasks widget shows upcoming or priority tasks. Its Settings button selects Home/Work, number of rows, and whether private tasks may appear. Done and Move date open the app.")
        button("Add tasks widget") { pin(TaskWidget::class.java) }
        label("Quick Settings capture tile")
        button("Add capture tile") {
            if (Build.VERSION.SDK_INT >= 33) getSystemService(StatusBarManager::class.java).requestAddTileService(
                ComponentName(this,CaptureTile::class.java), "Our place capture", Icon.createWithResource(this,R.drawable.ic_capture_tile), mainExecutor
            ) { result -> status.text=when(result) {
                StatusBarManager.TILE_ADD_REQUEST_RESULT_TILE_ADDED, StatusBarManager.TILE_ADD_REQUEST_RESULT_TILE_ALREADY_ADDED -> "Capture tile is ready in Quick Settings."
                else -> "You can add Our place capture using the Quick Settings edit button."
            } }
            else status.text="Swipe down twice, edit Quick Settings, and add Our place capture."
        }
        layout.addView(CheckBox(this).apply {
            text="Allow fresh capture over the lock screen"
            isChecked=CaptureTile.allowLocked(this@WidgetSetupActivity)
            setOnCheckedChangeListener { _, checked -> CaptureTile.setAllowLocked(this@WidgetSetupActivity,checked) }
        })
        label("Optional: anyone holding this phone can add a note while locked. Only the new capture is shown and read aloud; opening the inbox still requires unlocking. Enable the microphone first. Your phone may require unlocking to access Quick Settings.")
        button("Close") { finish() }
        setContentView(ScrollView(this).apply { addView(layout) })
    }
}
