package dev.ourplace.household

import android.content.Context
import android.content.Intent
import android.view.View
import android.widget.LinearLayout
import android.widget.TextView
import androidx.test.core.app.ApplicationProvider
import dev.ourplace.household.widgets.*
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class TaskWidgetTest {
    private val options = TaskWidgetOptions("owner-client", "owner", "epoch")
    private fun state(): JSONObject {
        fun row(id: String, scope: String, context: String, attention: String) = JSONObject()
            .put("taskId", id).put("occurrenceId", "$id-occurrence").put("title", id).put("scopeId", scope)
            .put("context", context).put("attention", attention).put("deadlineDate", JSONObject.NULL)
            .put("targetDate", if (attention == "ready") "2026-09-27" else JSONObject.NULL).put("reviewDate", JSONObject.NULL)
        val session = JSONObject().put("clientId", "owner-client").put("serverEpoch", "epoch")
            .put("person", JSONObject().put("personId", "owner").put("displayName", "Alex"))
            .put("scopes", JSONArray().put(JSONObject().put("scopeId", "shared").put("kind", "shared"))
                .put(JSONObject().put("scopeId", "private").put("kind", "private")))
        val data = JSONObject().put("version", 1).put("personId", "owner").put("sampledAt", 1000L)
            .put("rows", JSONArray().put(row("Priority", "shared", "home", "priority"))
                .put(row("Secret gift", "private", "home", "priority"))
                .put(row("Work target", "shared", "work", "ready"))
                .put(row("Partner private", "unavailable", "home", "priority"))
                .put(row("Later", "shared", "home", "upcoming")))
        return JSONObject().put("session", session).put("taskWidget", data).put("sampledAt", 1000L).put("recoveryRequired", false)
    }
    @Test fun defaultScopeContextFocusAndCapacityCannotExposePrivateRows() {
        val state = state()
        val model = TaskWidgetModel.render(state, options, 5)
        assertEquals(listOf("Priority", "Work target"), model.items.map { it.title })
        assertEquals("Aim for · 2026-09-27", model.items.last().detail)
        assertEquals(listOf("Priority"), TaskWidgetModel.render(state, options.copy(context = "home"), 5).items.map { it.title })
        assertEquals(listOf("Work target"), TaskWidgetModel.render(state, options.copy(context = "work"), 5).items.map { it.title })
        val private = TaskWidgetModel.render(state, options.copy(includePrivate = true, focusOnly = false, limit = 5), 2)
        assertEquals(listOf("Priority", "Secret gift"), private.items.map { it.title })
        assertEquals(4, private.total)
        assertFalse(private.items.any { it.title == "Partner private" })
    }
    @Test fun profileRecoveryAndCacheMismatchHideAllTaskContent() {
        for (change in listOf<(JSONObject) -> Unit>(
            { it.getJSONObject("session").put("clientId", "other-client") },
            { it.getJSONObject("session").getJSONObject("person").put("personId", "other") },
            { it.getJSONObject("session").put("serverEpoch", "restored") },
            { it.put("recoveryRequired", true) },
            { it.getJSONObject("taskWidget").put("personId", "other") },
            { it.getJSONObject("taskWidget").put("version", 99) },
            { it.put("sampledAt", 2000L) },
            { it.remove("session") },
            { it.remove("taskWidget") }
        )) {
            val state = state(); change(state)
            val model = TaskWidgetModel.render(state, options.copy(includePrivate = true), 5)
            assertFalse(model.ready); assertTrue(model.items.isEmpty()); assertNull(model.sampledAt)
        }
    }
    @Test fun optionsPersistPerInstanceAndRejectMalformedOrUnsupportedSettings() {
        val context = ApplicationProvider.getApplicationContext<Context>()
        val settings = TaskWidgetSettings(context)
        settings.save(21, options); settings.save(22, options.copy(context = "work", includePrivate = true))
        assertEquals(options, TaskWidgetSettings(context).read(21))
        assertTrue(TaskWidgetSettings(context).read(22)!!.includePrivate)
        settings.delete(21); assertNull(settings.read(21)); assertNotNull(settings.read(22))
        assertNull(TaskWidgetOptions.read("broken"))
        assertNull(TaskWidgetOptions.read(options.json().put("version", 2).toString()))
        assertNull(TaskWidgetOptions.read(options.json().put("limit", 0).toString()))
    }
    @Test fun remoteViewsRenderAndShortcutsCarryOnlyTheBoundOccurrenceAndProfile() {
        val context = ApplicationProvider.getApplicationContext<android.app.Application>()
        val model = TaskWidgetModel.render(state(), options, 1)
        val root = TaskWidget.views(context, 24, model, options).apply(context, LinearLayout(context))
        assertEquals("Alex · Tasks", root.findViewById<TextView>(R.id.widget_title).text.toString())
        assertEquals("Priority", root.findViewById<TextView>(R.id.widget_item_title).text.toString())
        assertEquals(1, root.findViewById<LinearLayout>(R.id.widget_items).childCount)
        for ((id, action) in listOf(R.id.widget_item_title to "show", R.id.widget_done to "complete", R.id.widget_move to "postpone")) {
            root.findViewById<View>(id).performClick()
            val intent: Intent = shadowOf(context).nextStartedActivity
            assertEquals(WidgetNavigation.ACTION, intent.action)
            assertEquals("owner-client", intent.getStringExtra("clientId"))
            assertEquals("epoch", intent.getStringExtra("serverEpoch"))
            assertEquals("Priority-occurrence", intent.getStringExtra("recordId"))
            assertEquals(action, intent.getStringExtra("taskAction"))
            assertFalse(intent.hasExtra("title"))
        }
        val hidden = TaskWidget.views(context, 24, TaskWidgetView("Our place", "Choose your profile"), options).apply(context, LinearLayout(context))
        assertEquals(0, hidden.findViewById<LinearLayout>(R.id.widget_items).childCount)
        assertEquals(View.GONE, hidden.findViewById<View>(R.id.widget_capture).visibility)
    }
}
