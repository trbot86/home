package dev.ourplace.household.capture
import android.app.Activity
import android.content.Intent
import android.os.Bundle
/** Exported share entry accepts text only and never starts the microphone. */
class ShareCaptureActivity : Activity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        if (intent.action == Intent.ACTION_SEND && intent.type == "text/plain") {
            val text = intent.getStringExtra(Intent.EXTRA_TEXT)?.take(20000) ?: ""
            startActivity(Intent(this, QuickCaptureActivity::class.java).putExtra("sharedText", text))
        }
        finish()
    }
}
