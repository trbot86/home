package dev.ourplace.household

import android.appwidget.AppWidgetManager
import android.widget.ImageView
import androidx.test.core.app.ApplicationProvider
import dev.ourplace.household.capture.CaptureWidget
import dev.ourplace.household.capture.QuickCaptureActivity
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class CaptureWidgetTest {
    @Test fun compactIconKeepsAccessibleVoiceCaptureShortcut() {
        val context = ApplicationProvider.getApplicationContext<android.app.Application>()
        val manager = AppWidgetManager.getInstance(context)
        val id = shadowOf(manager).createWidget(CaptureWidget::class.java, R.layout.capture_widget)
        val view = shadowOf(manager).getViewFor(id)
        val button = view.findViewById<ImageView>(R.id.capture_button)
        assertNotNull(button.drawable)
        assertEquals("Dictate a thought to Our place", button.contentDescription)
        button.performClick()
        val intent = shadowOf(context).nextStartedActivity
        assertEquals(QuickCaptureActivity::class.java.name, intent.component!!.className)
        assertTrue(intent.getBooleanExtra("voice", false))
        val xml = context.resources.getXml(R.xml.capture_widget)
        while (xml.next() != org.xmlpull.v1.XmlPullParser.START_TAG) { }
        val ns = "http://schemas.android.com/apk/res/android"
        assertEquals(1, xml.getAttributeIntValue(ns, "targetCellWidth", 0))
        assertEquals(1, xml.getAttributeIntValue(ns, "targetCellHeight", 0))
        xml.close()
    }
}
