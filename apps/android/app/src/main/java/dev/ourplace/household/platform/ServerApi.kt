package dev.ourplace.household.platform

import dev.ourplace.household.BuildConfig
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.net.HttpURLConnection
import java.net.URI
import java.net.URL

class ApiException(val code: String, val status: Int = 0) : Exception(code)
interface JsonTransport { fun json(path: String, method: String = "GET", body: String? = null, clientId: String? = null): JSONObject }
class ServerApi(private val endpoint: () -> String, private val credentials: CredentialStore) : JsonTransport {
    companion object {
        fun validateEndpoint(value: String): String {
            val uri = URI(value.trim()); require(uri.userInfo == null && uri.fragment == null && uri.query == null && (uri.path.isNullOrBlank() || uri.path == "/")) { "enter_the_server_origin_without_a_path" }
            require(uri.host != null && (uri.scheme == "https" || (BuildConfig.DEBUG && uri.scheme == "http" && uri.host in listOf("10.0.2.2", "127.0.0.1", "localhost")))) { "use_an_https_server_address" }
            return value.trim().trimEnd('/')
        }
    }
    fun bytes(path: String, method: String = "GET", body: ByteArray? = null, clientId: String? = null, mediaEpoch: String? = null): ByteArray {
        require(path.startsWith("/") && !path.startsWith("//"))
        val connection = URL("${validateEndpoint(endpoint())}/api$path").openConnection() as HttpURLConnection
        try {
            connection.requestMethod = method; connection.instanceFollowRedirects = false; connection.connectTimeout = 10000; connection.readTimeout = 20000
            connection.setRequestProperty("Accept", "application/json")
            if (clientId != null) { connection.setRequestProperty("Authorization", "Bearer ${credentials.get(clientId)}"); connection.setRequestProperty("x-client-id", clientId) }
            if (mediaEpoch != null) connection.setRequestProperty("x-server-epoch", mediaEpoch)
            if (body != null) {
                connection.setRequestProperty("Content-Type", if (mediaEpoch == null) "application/json" else "application/octet-stream")
                connection.doOutput = true; connection.setFixedLengthStreamingMode(body.size); connection.outputStream.use { it.write(body) }
            }
            val code = connection.responseCode; val input = if (code in 200..299) connection.inputStream else connection.errorStream
            val bytes = input?.use { stream ->
                val output = ByteArrayOutputStream(); val buffer = ByteArray(8192)
                while (true) { val count = stream.read(buffer); if (count < 0) break; if (output.size() + count > 26 * 1024 * 1024) throw ApiException("response_too_large"); output.write(buffer, 0, count) }
                output.toByteArray()
            } ?: byteArrayOf()
            if (code !in 200..299) throw ApiException(runCatching { JSONObject(String(bytes, Charsets.UTF_8)).optString("code", "request_failed") }.getOrDefault("request_failed"), code)
            return bytes
        } catch (error: java.io.IOException) { throw ApiException("server_unreachable") }
        finally { connection.disconnect() }
    }
    override fun json(path: String, method: String, body: String?, clientId: String?): JSONObject = JSONObject(String(bytes(path, method, body?.toByteArray(Charsets.UTF_8), clientId), Charsets.UTF_8))
}
