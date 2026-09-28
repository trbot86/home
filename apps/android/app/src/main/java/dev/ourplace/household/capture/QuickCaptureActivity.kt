package dev.ourplace.household.capture

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import android.speech.*
import android.speech.tts.TextToSpeech
import android.text.Editable
import android.text.TextWatcher
import android.widget.*
import androidx.activity.ComponentActivity
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.content.ContextCompat
import dev.ourplace.household.ClientCore
import dev.ourplace.household.MainActivity
import dev.ourplace.household.R
import dev.ourplace.household.storage.DraftRow
import java.util.Locale
import java.util.concurrent.Executors

/** A small foreground capture surface. Never starts a microphone from a background worker. */
class QuickCaptureActivity : ComponentActivity(), RecognitionListener {
    private lateinit var core: ClientCore
    private lateinit var editor: EditText
    private lateinit var status: TextView
    private lateinit var mic: Button
    private lateinit var secure: CheckBox
    private lateinit var save: Button
    private var draft: DraftRow? = null
    private var recognizer: SpeechRecognizer? = null
    private var speech: TextToSpeech? = null
    private var speechReady = false
    private var queuedSpeech: String? = null
    private var listening = false
    private var submitting = false
    private val network = Executors.newSingleThreadExecutor()
    private val permission = registerForActivityResult(ActivityResultContracts.RequestPermission()) { granted -> if (granted) listen() else status.text = "Microphone permission is off. You can still type." }
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState); core = ClientCore.get(this)
        val layout = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setPadding(28, 72, 28, 32); setBackgroundColor(getColor(R.color.household_background)) }
        layout.addView(TextView(this).apply { text = "A thought for our place"; textSize = 26f; setTextColor(getColor(R.color.household_accent)) })
        status = TextView(this).apply { text = "Opening your capture…"; setTextColor(getColor(R.color.household_muted)); setPadding(0, 18, 0, 18) }; layout.addView(status)
        editor = EditText(this).apply { hint = "Something to remember…"; minLines = 4; gravity = android.view.Gravity.TOP; inputType = android.text.InputType.TYPE_CLASS_TEXT or android.text.InputType.TYPE_TEXT_FLAG_MULTI_LINE; isEnabled = false }; layout.addView(editor)
        secure = CheckBox(this).apply {
            text = "Secure — exclude from AI context"; isEnabled = false
            setOnCheckedChangeListener { _, checked ->
                val current = draft ?: return@setOnCheckedChangeListener
                if (!submitting && current.state == "DRAFT") {
                    val text = editor.text.toString()
                    core.executor.execute { runCatching { core.saveDraft(current.draftId, text, current.scopeId, secure = checked) }
                        .onFailure { runOnUiThread { status.text = "Secure setting not saved. Try again before submitting." } } }
                }
            }
        }; layout.addView(secure)
        mic = Button(this).apply { text = "Start dictation"; isEnabled = false; setOnClickListener { if (listening) { recognizer?.stopListening(); text = "Finishing…"; isEnabled = false } else listen() } }; layout.addView(mic)
        save = Button(this).apply { text = "Save to inbox"; isEnabled = false; setOnClickListener { submit(false) } }; layout.addView(save)
        layout.addView(Button(this).apply { text = "Open inbox"; setOnClickListener { startActivity(Intent(this@QuickCaptureActivity, MainActivity::class.java)); finish() } })
        setContentView(layout)
        speech = TextToSpeech(this) { result -> speechReady = result == TextToSpeech.SUCCESS; if (speechReady) { speech?.language = Locale.getDefault(); queuedSpeech?.let(::speak) } }
        editor.addTextChangedListener(object : TextWatcher {
            override fun beforeTextChanged(s: CharSequence?, start: Int, count: Int, after: Int) {}
            override fun onTextChanged(s: CharSequence?, start: Int, before: Int, count: Int) {
                val current = draft ?: return; if (submitting || current.state != "DRAFT") return
                val text = s.toString(); core.executor.execute { runCatching { core.saveDraft(current.draftId, text, current.scopeId) }.onFailure { error -> runOnUiThread { status.text = "Draft not saved: ${error.message}" } } }
            }
            override fun afterTextChanged(s: Editable?) {}
        })
        core.executor.execute {
            try {
                val session = core.requireSession(); val scopes = session.getJSONArray("scopes"); val privateScope = (0 until scopes.length()).map { scopes.getJSONObject(it) }.first { it.getString("kind") == "private" }.getString("scopeId")
                val savedId = savedInstanceState?.getString("draftId")
                val current = if (savedId == null) core.createDraft(privateScope, if (intent.getBooleanExtra("voice", false)) "voice" else if (intent.hasExtra("sharedText")) "share" else "typed", intent.getStringExtra("category") ?: "inbox") else core.captures.draft(core.clientId(), savedId)
                draft = current
                val initial = if (savedId == null) intent.getStringExtra("sharedText")?.take(20000) ?: current.text else current.text
                runOnUiThread {
                    secure.isChecked = current.secure; secure.isEnabled = current.state == "DRAFT"
                    editor.setText(initial); editor.isEnabled = current.state == "DRAFT"; save.isEnabled = current.state == "DRAFT"; mic.isEnabled = current.state == "DRAFT"
                    status.text = if (current.state == "DRAFT") "Visibility: ${if (current.scopeId == privateScope) "Just me" else "Shared"}. Saved drafts stay on this phone. Dictation will save and read back the final words." else "Saved on this phone. Waiting for confirmation from the server."
                    if (savedId == null && intent.getBooleanExtra("voice", false)) listen()
                }
            } catch (_: Exception) { runOnUiThread { status.text = "Open the app and choose your profile before capturing." } }
        }
    }
    override fun onSaveInstanceState(outState: Bundle) { outState.putString("draftId", draft?.draftId); super.onSaveInstanceState(outState) }
    private fun listen() {
        if (submitting) return
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) { permission.launch(Manifest.permission.RECORD_AUDIO); return }
        if (!SpeechRecognizer.isRecognitionAvailable(this)) { status.text = "Speech recognition is unavailable. You can type, or use your keyboard’s microphone."; return }
        recognizer?.destroy()
        recognizer = if (Build.VERSION.SDK_INT >= 31 && SpeechRecognizer.isOnDeviceRecognitionAvailable(this)) SpeechRecognizer.createOnDeviceSpeechRecognizer(this) else SpeechRecognizer.createSpeechRecognizer(this)
        recognizer!!.setRecognitionListener(this)
        val request = Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH).putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM).putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, true)
        recognizer!!.startListening(request); listening = true; mic.text = "Stop dictation"; status.text = "Listening…"; save.isEnabled = false
    }
    private fun submit(readBack: Boolean) {
        val current = draft ?: return; if (submitting) return
        val text = editor.text.toString(); if (text.isBlank()) { status.text = "Say or type a thought first."; return }
        val secureCapture = secure.isChecked
        submitting = true; secure.isEnabled = false; editor.isEnabled = false; save.isEnabled = false; mic.isEnabled = false
        core.executor.execute {
            try {
                core.saveDraft(current.draftId, text, current.scopeId, secure = secureCapture); core.submitDraft(current.draftId)
                runOnUiThread { status.text = "Saved on this phone · waiting to sync"; if (readBack) speak("Saved on this phone, waiting to sync: $text") }
                network.execute {
                    runCatching { core.sync() }
                    val accepted = core.captures.draft(current.clientId, current.draftId).state == "ACKNOWLEDGED"
                    if (accepted) runOnUiThread { status.text = "Saved to your inbox. Open the inbox to edit." }
                }
            } catch (error: Exception) {
                val stillEditable = runCatching { core.captures.draft(current.clientId, current.draftId).state == "DRAFT" }.getOrDefault(false)
                submitting = !stillEditable
                runOnUiThread { secure.isEnabled = stillEditable; editor.isEnabled = stillEditable; save.isEnabled = stillEditable; mic.isEnabled = stillEditable; status.text = if (stillEditable) "Not submitted: ${error.message}" else "Saved on this phone. Open the inbox to check sync status." }
            }
        }
    }
    private fun speak(text: String) { if (!speechReady) { queuedSpeech = text; return }; queuedSpeech = null; speech?.speak(text, TextToSpeech.QUEUE_FLUSH, null, "capture-readback") }
    override fun onResults(results: Bundle?) { listening = false; mic.text = "Start dictation"; mic.isEnabled = true; save.isEnabled = true; val text = results?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)?.firstOrNull(); if (text.isNullOrBlank()) status.text = "No words captured. Try again." else { editor.setText(text); submit(true) } }
    override fun onPartialResults(results: Bundle?) { val partial = results?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)?.firstOrNull(); if (partial != null) status.text = "Hearing: $partial" }
    override fun onError(error: Int) { listening = false; mic.text = "Try dictation again"; mic.isEnabled = true; save.isEnabled = true; status.text = "Dictation stopped ($error). Your saved draft is still here." }
    override fun onReadyForSpeech(params: Bundle?) {}
    override fun onBeginningOfSpeech() {}
    override fun onRmsChanged(rmsdB: Float) {}
    override fun onBufferReceived(buffer: ByteArray?) {}
    override fun onEndOfSpeech() { status.text = "Finishing recognition…" }
    override fun onEvent(eventType: Int, params: Bundle?) {}
    override fun onDestroy() { recognizer?.destroy(); speech?.shutdown(); network.shutdown(); super.onDestroy() }
}
