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
    private val options = TaskWidgetOptions("owner-client", "owner", "epoch", focusOnly = true)
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
        val compact = TaskWidgetModel.render(state, options, 0)
        assertTrue(compact.ready); assertTrue(compact.items.isEmpty()); assertEquals(2, compact.total)
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
            val state = calendarState(); change(state)
            val model = TaskWidgetModel.render(state, options.copy(includePrivate = true), 5)
            assertFalse(model.ready); assertTrue(model.items.isEmpty()); assertTrue(model.calendar.isEmpty()); assertNull(model.sampledAt)
        }
    }
    @Test fun newWidgetsShowUpcomingAndUndatedTasksWithoutOptingIntoPrivateTasks() {
        val state = state()
        val rows = state.getJSONObject("taskWidget").getJSONArray("rows")
        rows.getJSONObject(0).put("attention", "anytime")
        val defaults = TaskWidgetOptions("owner-client", "owner", "epoch")
        assertEquals(listOf("Priority", "Work target", "Later"),
            TaskWidgetModel.render(state, defaults, 5).items.map { it.title })
        assertFalse(defaults.includePrivate)
        // A saved focus preference survives the change to new-widget defaults.
        assertTrue(TaskWidgetOptions.read(options.json().toString())!!.focusOnly)
    }
    @Test fun emptyFocusAndTooSmallLayoutsExplainHowToSeeTasks() {
        val state = state()
        val rows = state.getJSONObject("taskWidget").getJSONArray("rows")
        for (i in 0 until rows.length()) rows.getJSONObject(i).put("attention", "anytime")
        val filtered = TaskWidgetModel.render(state, options, 3)
        assertTrue(filtered.ready); assertTrue(filtered.items.isEmpty())
        assertTrue(filtered.message.contains("Turn off Focus in Settings"))
        val compact = TaskWidgetModel.render(state, options.copy(focusOnly = false), 0)
        assertEquals(3, compact.total); assertTrue(compact.items.isEmpty())
        assertEquals("Resize to see tasks.", compact.message)
        val context = ApplicationProvider.getApplicationContext<android.app.Application>()
        val root = TaskWidget.views(context, 25, compact, options).apply(context, LinearLayout(context))
        assertEquals(View.GONE, root.findViewById<View>(R.id.widget_sampled).visibility)
        assertEquals(View.VISIBLE, root.findViewById<View>(R.id.widget_message).visibility)
    }
    @Test fun compactRowsFitFiveAt392dpAndRespectSmallerBounds() {
        val context = ApplicationProvider.getApplicationContext<android.app.Application>()
        val state = state()
        val rows = state.getJSONObject("taskWidget").getJSONArray("rows")
        rows.put(JSONObject(rows.getJSONObject(0).toString()).put("taskId", "extra").put("occurrenceId", "extra-occurrence"))
        val settings = options.copy(includePrivate = true, focusOnly = false, limit = 5)
        for (height in listOf(140, 168, 224, 280, 336, 392, 600)) {
            val count = TaskWidget.capacityForHeight(height)
            val model = TaskWidgetModel.render(state, settings, count)
            assertEquals(count, model.items.size)
            val root = TaskWidget.views(context, 30, model, settings).apply(context, LinearLayout(context))
            val density = context.resources.displayMetrics.density
            root.measure(View.MeasureSpec.makeMeasureSpec((320 * density).toInt(), View.MeasureSpec.EXACTLY),
                View.MeasureSpec.makeMeasureSpec((height * density).toInt(), View.MeasureSpec.EXACTLY))
            root.layout(0, 0, root.measuredWidth, root.measuredHeight)
            val items = root.findViewById<LinearLayout>(R.id.widget_items)
            assertEquals(count, items.childCount)
            if (count > 0) assertTrue("Rows must fit at $height dp", items.getChildAt(count - 1).bottom <= items.height)
            assertFalse(model.items.any { it.title == "Partner private" })
        }
        assertEquals(5, TaskWidget.capacityForHeight(392))
        assertEquals(3, TaskWidget.capacityForHeight(336))
        assertEquals(3, TaskWidgetModel.render(state, settings.copy(limit = 3), 5).items.size)
    }
    @Test fun headingAndMoreOpenAgendaWithProfileAndRecoveryGuards() {
        val context = ApplicationProvider.getApplicationContext<android.app.Application>()
        val model = TaskWidgetModel.render(state(), options, 1)
        val root = TaskWidget.views(context, 31, model, options).apply(context, LinearLayout(context))
        assertEquals("Agenda · 1 more", root.findViewById<TextView>(R.id.widget_more).text.toString())
        for (id in listOf(R.id.widget_title, R.id.widget_more)) {
            root.findViewById<View>(id).performClick()
            val intent = shadowOf(context).nextStartedActivity
            assertEquals(WidgetNavigation.ACTION, intent.action)
            assertEquals("agenda", intent.getStringExtra("taskAction"))
            assertEquals("owner-client", intent.getStringExtra("clientId"))
            assertEquals("epoch", intent.getStringExtra("serverEpoch"))
            assertFalse(intent.hasExtra("recordId"))
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
        assertEquals("Alex · Agenda", root.findViewById<TextView>(R.id.widget_title).text.toString())
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
    private fun calendarState(): JSONObject {
        val state = state()
        state.getJSONObject("taskWidget").put("date", "2026-09-27").put("timeZone", "America/Toronto")
            .put("calendarTasks", JSONArray().put(JSONObject().put("occurrenceId", "dated")
                .put("scopeId", "shared").put("context", "home").put("title", "Dated task")
                .put("day", "2026-09-28").put("completed", false)))
        fun event(title: String, visibility: String = "default") = JSONObject().put("title", title)
            .put("visibility", visibility).put("timing", JSONObject().put("kind", "all_day")
                .put("startDate", "2026-09-27").put("endDate", "2026-09-28"))
        fun calendar(scope: String, context: String, title: String) = JSONObject().put("scopeId", scope)
            .put("context", context).put("refreshedAt", 1000L).put("errorCode", JSONObject.NULL)
            .put("events", JSONArray().put(event(title)))
        val shared = calendar("shared", "home", "Shared event")
        shared.getJSONArray("events").put(event("Confidential event", "confidential"))
            .put(JSONObject().put("title", "Overnight").put("timing", JSONObject().put("kind", "timed")
                .put("startAt", java.time.Instant.parse("2026-09-28T03:00:00Z").toEpochMilli())
                .put("endAt", java.time.Instant.parse("2026-09-28T05:00:00Z").toEpochMilli())))
        state.put("agenda", JSONObject().put("needsReconnect", false).put("calendars", JSONArray()
            .put(shared).put(calendar("private", "work", "My private event"))
            .put(calendar("unavailable", "home", "Other private event"))))
        return state
    }
    @Test fun calendarCombinesDatedTasksAndEventsWithExclusiveEndsAndPrivacy() {
        val state = calendarState()
        val before = state.toString()
        val settings = options.copy(focusOnly = true, limit = 5)
        val model = TaskWidgetModel.render(state, settings, 5)
        assertTrue(model.ready)
        assertEquals(listOf("Shared event", "Overnight", "Dated task", "Overnight"), model.calendar.map { it.title })
        assertEquals("2026-09-27 · 23:00", model.calendar[1].detail)
        assertEquals("2026-09-28 · Continues", model.calendar.last().detail)
        assertEquals(6, TaskWidgetModel.render(state, settings.copy(includePrivate = true), 5).calendarTotal)
        assertEquals(listOf("My private event"), TaskWidgetModel.render(state,
            settings.copy(includePrivate = true, context = "work"), 5).calendar.map { it.title })
        assertEquals(before, state.toString())
        state.put("recoveryRequired", true)
        assertTrue(TaskWidgetModel.render(state, settings.copy(includePrivate = true), 5).calendar.isEmpty())
    }
    @Test fun wideWidgetFitsBothColumnsAndCalendarOpensGuardedAgenda() {
        val context = ApplicationProvider.getApplicationContext<android.app.Application>()
        val settings = options.copy(includePrivate = true, limit = 5)
        val model = TaskWidgetModel.render(calendarState(), settings, 5)
        val root = TaskWidget.views(context, 40, model, settings, true).apply(context, LinearLayout(context))
        val density = context.resources.displayMetrics.density
        root.measure(View.MeasureSpec.makeMeasureSpec((320 * density).toInt(), View.MeasureSpec.EXACTLY),
            View.MeasureSpec.makeMeasureSpec((392 * density).toInt(), View.MeasureSpec.EXACTLY))
        root.layout(0, 0, root.measuredWidth, root.measuredHeight)
        val calendar = root.findViewById<LinearLayout>(R.id.widget_calendar_items)
        assertEquals(5, calendar.childCount)
        assertTrue(calendar.getChildAt(4).bottom <= calendar.height)
        assertTrue(calendar.width > 0)
        calendar.getChildAt(0).findViewById<View>(R.id.widget_item_title).performClick()
        val intent = shadowOf(context).nextStartedActivity
        assertEquals("agenda", intent.getStringExtra("taskAction"))
        assertEquals("owner-client", intent.getStringExtra("clientId"))
        assertEquals("epoch", intent.getStringExtra("serverEpoch"))
        assertFalse(intent.hasExtra("title"))
        val narrow = TaskWidget.views(context, 41, model, settings).apply(context, LinearLayout(context))
        assertEquals(View.GONE, narrow.findViewById<View>(R.id.widget_calendar_column).visibility)
    }

}
