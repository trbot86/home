package dev.ourplace.household.capture

import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.widget.LinearLayout
import android.widget.TextView
import android.widget.Button
import androidx.activity.ComponentActivity
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.content.FileProvider
import dev.ourplace.household.ClientCore
import dev.ourplace.household.storage.AcquisitionRow
import dev.ourplace.household.storage.newId
import dev.ourplace.household.storage.ValueRow
import java.io.File

/** Persists acquisition identity before leaving for an external camera or picker. */
class PhotoCaptureActivity : ComponentActivity() {
    private lateinit var core: ClientCore
    private lateinit var status: TextView
    private var acquisitionId: String? = null
    private val camera = registerForActivityResult(ActivityResultContracts.TakePicture()) { success ->
        if (success) complete(null) else incomplete("No photo was saved. Your draft is still here.")
    }
    private val gallery = registerForActivityResult(ActivityResultContracts.OpenDocument()) { uri ->
        if (uri == null) incomplete("No photo selected. Your draft is still here.") else {
            runCatching { contentResolver.takePersistableUriPermission(uri, Intent.FLAG_GRANT_READ_URI_PERMISSION) }
            complete(uri)
        }
    }
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState); core = ClientCore.get(this)
        status = TextView(this).apply { text = "Preparing your photo…"; textSize = 18f }
        setContentView(LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setPadding(32, 80, 32, 32); addView(status); addView(Button(this@PhotoCaptureActivity).apply { text = "Back to your draft"; setOnClickListener { finish() } }) })
        acquisitionId = savedInstanceState?.getString("acquisitionId")
        if (acquisitionId != null) { status.text = "Waiting for your photo. If the camera was interrupted, return to your draft and try again."; return }
        core.executor.execute {
            try {
                val owner = core.clientId(); val draftId = intent.getStringExtra("draftId") ?: error("draft_required")
                val targetKind = intent.getStringExtra("targetKind") ?: "inbox"; require(targetKind in listOf("inbox", "record"))
                val state = if (targetKind == "record") core.attachmentDrafts.read(owner, draftId).state else core.captures.draft(owner, draftId).state
                check(state == "DRAFT"); val mode = intent.getStringExtra("mode") ?: "gallery"; val id = newId()
                val pending = core.db.dao().pendingAcquisitions(owner).firstOrNull { it.draftId == draftId && it.kind == mode && it.targetKind == targetKind }
                if (pending != null) {
                    val savedUri = core.db.dao().value("acquisition:${pending.acquisitionId}")
                    if (savedUri != null || File(pending.path).length() > 0) {
                        acquisitionId = pending.acquisitionId
                        runOnUiThread { status.text = "Recovering your interrupted photo…" }
                        complete(savedUri?.let(Uri::parse)); return@execute
                    }
                    core.db.dao().updateAcquisition(pending.copy(state = "cancelled"))
                }
                val directory = File(filesDir, "photo-acquisitions").apply { mkdirs() }; val file = File(directory, "$id.jpg")
                val row = AcquisitionRow(id, owner, draftId, file.path, mode, "pending", System.currentTimeMillis(), targetKind); core.db.dao().insertAcquisition(row); acquisitionId = id
                runOnUiThread {
                    if (mode == "camera") camera.launch(FileProvider.getUriForFile(this, "$packageName.fileprovider", file))
                    else gallery.launch(arrayOf("image/jpeg", "image/png", "image/webp"))
                }
            } catch (error: Exception) { incomplete(error.message ?: "Could not open the photo picker.") }
        }
    }
    override fun onSaveInstanceState(outState: Bundle) { outState.putString("acquisitionId", acquisitionId); super.onSaveInstanceState(outState) }
    private fun complete(uri: Uri?) {
        val id = acquisitionId ?: return incomplete("Photo request not found. Your draft is still here.")
        core.executor.execute {
            try {
                val row = core.db.dao().acquisition(id) ?: error("photo_request_missing")
                check(row.clientId == core.clientId()) { "session_changed" }
                if (row.state == "complete") { runOnUiThread { finish() }; return@execute }
                uri?.let { core.db.dao().putValue(ValueRow("acquisition:$id", it.toString())) }
                val type = uri?.let { contentResolver.getType(it) } ?: "image/jpeg"
                val input = if (uri == null) File(row.path).inputStream() else contentResolver.openInputStream(uri) ?: error("photo_unavailable")
                val media = input.use { core.media.acquire(row.clientId, type, it) }
                try { core.db.runInTransaction {
                    if (row.targetKind == "record") core.attachmentDrafts.attach(row.clientId, row.draftId, media)
                    else core.captures.attach(row.clientId, row.draftId, media)
                    core.db.dao().updateAcquisition(row.copy(state = "complete"))
                    core.db.dao().deleteValue("acquisition:$id")
                } } finally { core.media.removeUnattached(media) }
                File(row.path).delete(); uri?.let { runCatching { contentResolver.releasePersistableUriPermission(it, Intent.FLAG_GRANT_READ_URI_PERMISSION) } }
                core.changed(); runOnUiThread { finish() }
            } catch (error: Exception) { incomplete(error.message ?: "The photo could not be saved. Your draft is still here.") }
        }
    }
    private fun incomplete(text: String) { runOnUiThread { status.text = text } }
}
