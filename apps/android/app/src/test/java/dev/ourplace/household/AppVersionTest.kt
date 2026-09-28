package dev.ourplace.household

import dev.ourplace.household.platform.AppVersion
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import java.net.ServerSocket
import kotlin.concurrent.thread

@RunWith(RobolectricTestRunner::class)
class AppVersionTest {
    @Test fun fingerprintsInstalledApkWithoutChangingIt() {
        val file = java.io.File.createTempFile("installed-app", ".apk")
        try {
            file.writeText("abc")
            val context = object : android.content.ContextWrapper(androidx.test.core.app.ApplicationProvider.getApplicationContext<android.content.Context>()) {
                override fun getApplicationInfo() = android.content.pm.ApplicationInfo(super.getApplicationInfo()).also { it.sourceDir = file.absolutePath }
            }
            val value = AppVersion.installed(context)
            assertEquals(BuildConfig.VERSION_NAME, value.getString("version"))
            assertEquals("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad", value.getString("sha256"))
            assertEquals("abc", file.readText())
        } finally { file.delete() }
    }

    private fun response(body: String, status: String = "200 OK"): Pair<String, Thread> {
        val server = ServerSocket(0)
        val origin = "http://127.0.0.1:${server.localPort}"
        val worker = thread(isDaemon = true) {
            server.use { it.accept().use { socket ->
                socket.soTimeout = 5000
                val reader = socket.getInputStream().bufferedReader()
                assertEquals("GET /install/build.json HTTP/1.1", reader.readLine())
                val headers = mutableListOf<String>()
                while (true) { val line = reader.readLine(); if (line.isEmpty()) break; headers.add(line) }
                assertFalse(headers.any { it.startsWith("Authorization:", true) || it.startsWith("Cookie:", true) })
                socket.getOutputStream().write("HTTP/1.1 $status\r\nContent-Length: ${body.toByteArray().size}\r\nConnection: close\r\n\r\n$body".toByteArray())
            } }
        }
        return origin to worker
    }

    @Test fun readsOnlyPublicFingerprint() {
        val hash = "a".repeat(64)
        val (origin, worker) = response("{\"sha256\":\"$hash\",\"extra\":\"ignored\"}")
        val value = AppVersion.published(origin)
        worker.join()
        assertEquals(hash, value.getString("sha256"))
        assertEquals(1, value.length())
    }

    @Test fun rejectsUnavailableMalformedAndOversizeMetadata() {
        for ((body, status) in listOf("{}" to "404 Not Found", "{}" to "302 Found", "{}" to "200 OK", "x".repeat(4097) to "200 OK")) {
            val (origin, worker) = response(body, status)
            assertTrue(runCatching { AppVersion.published(origin) }.isFailure)
            worker.join()
        }
    }
}
