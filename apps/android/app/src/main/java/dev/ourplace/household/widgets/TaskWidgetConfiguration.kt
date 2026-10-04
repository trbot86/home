package dev.ourplace.household.widgets

import android.app.Activity
import android.appwidget.AppWidgetManager
import android.content.Intent
import android.content.ComponentName
import android.os.Bundle
import android.widget.*
import androidx.appcompat.app.AppCompatActivity
import dev.ourplace.household.ClientCore
import dev.ourplace.household.R
import dev.ourplace.household.sync.UploadWorker
import org.json.JSONObject

class TaskWidgetConfiguration : AppCompatActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setResult(Activity.RESULT_CANCELED)
        val id = intent.getIntExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, AppWidgetManager.INVALID_APPWIDGET_ID)
        if (id == AppWidgetManager.INVALID_APPWIDGET_ID || AppWidgetManager.getInstance(this).getAppWidgetInfo(id)?.provider != ComponentName(this, TaskWidget::class.java)) { finish(); return }
        val core = ClientCore.get(this)
        core.executor.execute {
            val session = core.session()
            runOnUiThread { showForm(core, id, session) }
        }
    }
    private fun showForm(core: ClientCore, id: Int, session: JSONObject?) {
        val padding = (20 * resources.displayMetrics.density).toInt()
        val layout = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL; setPadding(padding, padding * 2, padding, padding)
            setBackgroundColor(getColor(R.color.household_background))
        }
        fun label(value: String, size: Float = 16f) = TextView(this).apply {
            text = value; textSize = size; setTextColor(getColor(R.color.household_accent)); setPadding(0, padding / 2, 0, padding / 2)
            layout.addView(this)
        }
        label("Our place · Task widget", 24f)
        if (session == null) {
            label("Open Our place and choose your profile, then add the widget again.")
            layout.addView(Button(this).apply { text = "Close"; setOnClickListener { finish() } })
            setContentView(layout); return
        }
        val clientId = session.getString("clientId"); val epoch = session.getString("serverEpoch")
        label("For ${session.getJSONObject("person").getString("displayName")}. The widget hides its tasks when you switch profiles.")
        val previous = TaskWidgetSettings(this).read(id)?.takeIf { it.clientId == clientId && it.serverEpoch == epoch }
        fun select(title: String, labels: Array<String>, selected: Int): Spinner {
            label(title)
            return Spinner(this).apply {
                contentDescription = title
                adapter = ArrayAdapter(this@TaskWidgetConfiguration, android.R.layout.simple_spinner_dropdown_item, labels)
                setSelection(selected); layout.addView(this)
            }
        }
        val contexts = listOf("both", "home", "work")
        val context = select("Home / Work", arrayOf("Home + Work", "Home", "Work"), contexts.indexOf(previous?.context ?: "both"))
        val limit = select("Maximum tasks", arrayOf("1", "2", "3", "4", "5"), (previous?.limit ?: 3) - 1)
        val focus = CheckBox(this).apply { text = "Focus on tasks needing attention"; isChecked = previous?.focusOnly ?: false; layout.addView(this) }
        val private = CheckBox(this).apply { text = "Include my private tasks"; isChecked = previous?.includePrivate ?: false; layout.addView(this) }
        label("Private task titles would be visible on this phone’s home screen. Shared tasks are shown by default. You can resize the widget to see more rows.", 14f)
        label("Done and Date open the app’s confirmation controls. Cached tasks stay visible offline. Background refresh timing is managed by Android.", 14f)
        val status = label("", 14f)
        layout.addView(Button(this).apply {
            text = "Save widget"
            setOnClickListener {
                isEnabled = false
                val options = TaskWidgetOptions(clientId, session.getJSONObject("person").getString("personId"), epoch,
                    contexts[context.selectedItemPosition], private.isChecked, focus.isChecked, limit.selectedItemPosition + 1)
                core.executor.execute {
                    try {
                        val current = core.requireSession()
                        check(current.getString("clientId") == clientId && current.getString("serverEpoch") == epoch) { "Profile changed. Reopen widget settings." }
                        TaskWidgetSettings(this@TaskWidgetConfiguration).save(id, options)
                        TaskWidget.refreshAll(this@TaskWidgetConfiguration); TaskWidgetWorker.schedule(this@TaskWidgetConfiguration)
                        UploadWorker.schedule(this@TaskWidgetConfiguration)
                        runOnUiThread {
                            setResult(Activity.RESULT_OK, Intent().putExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, id)); finish()
                        }
                    } catch (error: Exception) { runOnUiThread { status.text = error.message; isEnabled = true } }
                }
            }
        })
        layout.addView(Button(this).apply { text = "Cancel"; setOnClickListener { finish() } })
        setContentView(ScrollView(this).apply { addView(layout) })
    }
}
