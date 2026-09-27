package dev.ourplace.household.platform

import android.content.Context
import android.system.Os
import android.system.OsConstants
import dev.ourplace.household.storage.*
import java.io.File
import java.io.FileOutputStream
import java.io.InputStream

class MediaStore(context: Context, private val db: LocalDatabase) {
    val root = File(context.filesDir, "capture-media").apply { mkdirs() }
    fun path(id: String): File { require(id.matches(Regex("[a-f0-9-]{36}"))); return File(root, "$id.bin") }
    fun syncDirectory() { val fd = Os.open(root.path, OsConstants.O_RDONLY, 0); try { Os.fsync(fd) } finally { Os.close(fd) } }
    fun acquire(clientId: String, mimeType: String, source: InputStream): MediaRow {
        require(mimeType in listOf("image/jpeg", "image/png", "image/webp")) { "choose_a_jpeg_png_or_webp" }
        val id = newId(); val partial = File(root, "$id.partial"); val destination = path(id)
        var length = 0L
        try {
            FileOutputStream(partial).use { output ->
                val buffer = ByteArray(8192)
                while (true) { val count = source.read(buffer); if (count < 0) break; length += count; require(length <= 25 * 1024 * 1024) { "photo_exceeds_25_mb" }; output.write(buffer, 0, count) }
                require(length > 0) { "empty_photo" }; output.fd.sync()
            }
            check(partial.renameTo(destination)) { "photo_publication_failed" }; syncDirectory()
            return MediaRow(id, clientId, destination.path, sha256(destination.readBytes()), length, mimeType)
        } finally { partial.delete() }
    }
    fun read(clientId: String, mediaId: String): ByteArray {
        val row = db.dao().media(mediaId)?.takeIf { it.clientId == clientId } ?: error("photo_unavailable")
        val file = path(row.mediaId); check(file.path == row.path) { "invalid_media_path" }
        val bytes = file.readBytes(); check(bytes.size.toLong() == row.byteLength && sha256(bytes) == row.digest) { "pending_photo_integrity_error" }; return bytes
    }
    fun remove(clientId: String, mediaId: String) {
        val row = db.dao().media(mediaId)?.takeIf { it.clientId == clientId } ?: return
        check(path(row.mediaId).delete() || !path(row.mediaId).exists()); syncDirectory(); db.dao().deleteMedia(mediaId)
    }
}
