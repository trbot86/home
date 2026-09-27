package dev.ourplace.household

import android.content.Intent
import dev.ourplace.household.platform.WebLinks
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import java.net.URI

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], manifest = Config.NONE)
class WebLinksTest {
    @Test fun webNavigationUsesAnExternalBrowsableIntent() {
        val intent = WebLinks.intent("https://example.com/recipe?ingredients=tea%20%26%20milk#method")
        assertEquals(Intent.ACTION_VIEW, intent.action)
        assertTrue(intent.hasCategory(Intent.CATEGORY_BROWSABLE))
        assertEquals("https://example.com/recipe?ingredients=tea%20%26%20milk#method", intent.dataString)
        assertNull(intent.component); assertNull(intent.extras)
    }
    @Test fun arbitraryIntentSchemesAndCredentialUrlsAreRejected() {
        val withUserInfo = URI("https", "fixture:fixture", "example.com", -1, "/", null, null).toString()
        for (value in listOf("javascript:alert(1)", "intent://example.com/#Intent;end", "file:///data/local/file", "content://private/file", withUserInfo, "https:///missing-host", "https://example.com/\nnext")) {
            assertTrue("Must reject $value", runCatching { WebLinks.intent(value) }.isFailure)
        }
    }
}
