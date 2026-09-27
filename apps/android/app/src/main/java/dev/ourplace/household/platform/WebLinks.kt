package dev.ourplace.household.platform

import android.content.Intent
import android.net.Uri
import java.net.URI

object WebLinks {
    fun intent(value: String): Intent {
        val uri = URI(value)
        require(uri.scheme?.lowercase() in listOf("http", "https") && !uri.host.isNullOrBlank() && uri.rawUserInfo == null) { "invalid_web_link" }
        return Intent(Intent.ACTION_VIEW, Uri.parse(uri.toASCIIString())).addCategory(Intent.CATEGORY_BROWSABLE)
    }
}
