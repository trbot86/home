package dev.ourplace.household.platform

import android.content.Context
import dev.ourplace.household.BuildConfig
import org.json.JSONObject
import java.io.File
import java.net.HttpURLConnection
import java.net.URL
import java.security.MessageDigest

/** Read-only package inspection; never touches captures, credentials or installation identity. */
object AppVersion {
    private var installed: JSONObject? = null

    @Synchronized fun installed(context: Context): JSONObject {
        installed?.let { return it }
        val digest = MessageDigest.getInstance("SHA-256")
        File(context.applicationInfo.sourceDir).inputStream().use { input ->
            val buffer = ByteArray(65536)
            while (true) {
                val count = input.read(buffer)
                if (count < 0) break
                digest.update(buffer, 0, count)
            }
        }
        return JSONObject().put("version", BuildConfig.VERSION_NAME)
            .put("sha256", digest.digest().joinToString("") { "%02x".format(it) })
            .also { installed = it }
    }

    fun published(origin: String): JSONObject {
        val connection = URL("${ServerApi.validateEndpoint(origin)}/install/build.json")
            .openConnection() as HttpURLConnection
        try {
            connection.instanceFollowRedirects = false
            connection.connectTimeout = 5000
            connection.readTimeout = 5000
            connection.useCaches = false
            connection.setRequestProperty("Cache-Control", "no-cache")
            require(connection.responseCode == 200) { "update_check_unavailable" }
            val bytes = connection.inputStream.use { input ->
                val output = java.io.ByteArrayOutputStream()
                val buffer = ByteArray(1024)
                while (true) {
                    val count = input.read(buffer)
                    if (count < 0) break
                    require(output.size() + count <= 4096) { "update_metadata_too_large" }
                    output.write(buffer, 0, count)
                }
                output.toByteArray()
            }
            require(bytes.size <= 4096) { "update_metadata_too_large" }
            val metadata = JSONObject(String(bytes, Charsets.UTF_8))
            val hash = metadata.getString("sha256")
            require(Regex("[a-f0-9]{64}").matches(hash)) { "invalid_update_metadata" }
            return JSONObject().put("sha256", hash)
        } finally { connection.disconnect() }
    }
}
