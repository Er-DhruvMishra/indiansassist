package com.indiansassist.desk.service

import android.content.ContentValues
import android.content.Context
import android.net.Uri
import android.provider.MediaStore
import android.provider.OpenableColumns
import com.indiansassist.desk.core.Bytes
import com.indiansassist.desk.core.FileNames
import com.indiansassist.desk.core.FileReceiver
import com.indiansassist.desk.core.FileSink
import com.indiansassist.desk.core.IncomingOffer
import com.indiansassist.desk.core.OutboxEntry
import com.indiansassist.desk.core.obj
import kotlinx.serialization.json.JsonObject
import java.io.OutputStream
import java.security.MessageDigest

/**
 * Received files go to `Download/IndiansAssist/` through MediaStore (scoped storage, min SDK 29): inserted with
 * `IS_PENDING = 1`, streamed, and published only after `file.done` and a matching sha256 (C section 6.1 F3 on
 * Android); a mismatch or a cancel deletes the pending row. MediaStore picks a collision-free display name.
 */
class DownloadsSink(private val ctx: Context, offer: IncomingOffer) : FileSink {
    private val uri: Uri
    private val out: OutputStream

    init {
        val values = ContentValues().apply {
            put(MediaStore.Downloads.DISPLAY_NAME, offer.name)
            put(MediaStore.Downloads.MIME_TYPE, "application/octet-stream")
            put(MediaStore.Downloads.RELATIVE_PATH, "Download/IndiansAssist")
            put(MediaStore.Downloads.IS_PENDING, 1)
        }
        uri = ctx.contentResolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values) ?: throw IllegalStateException("MediaStore insert failed")
        out = ctx.contentResolver.openOutputStream(uri, "w") ?: throw IllegalStateException("cannot open $uri")
    }

    override fun write(bytes: ByteArray, off: Int, len: Int) = out.write(bytes, off, len)

    override fun commit(): String {
        out.close()
        ctx.contentResolver.update(uri, ContentValues().apply { put(MediaStore.Downloads.IS_PENDING, 0) }, null, null)
        return uri.toString()
    }

    override fun abort() {
        try { out.close() } catch (_: Exception) {}
        try { ctx.contentResolver.delete(uri, null, null) } catch (_: Exception) {}
    }
}

/**
 * Desk -> Assist file send (A section 8.3, C section 6.1 F5): sha256 computed streaming before `file.offer`, then the
 * 16 KiB chunks after `file.accept`, under the A F3 back-pressure (`bufferedAmount` above 1 MiB waits).
 */
class FileSender(private val ctx: Context, private val uri: Uri, val fileId: Long) {
    var name: String = "file-$fileId"
        private set
    var size: Long = 0
        private set
    var sha256: String = ""
        private set

    fun prepare(): JsonObject {
        ctx.contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE), null, null, null)?.use { c ->
            if (c.moveToFirst()) {
                name = FileNames.sanitise(c.getString(0) ?: name, fileId)
                size = c.getLong(1)
            }
        }
        val md = MessageDigest.getInstance("SHA-256")
        var total = 0L
        ctx.contentResolver.openInputStream(uri)?.use { input ->
            val buf = ByteArray(65536)
            while (true) {
                val n = input.read(buf)
                if (n < 0) break
                md.update(buf, 0, n)
                total += n
            }
        }
        size = total
        sha256 = Bytes.hex(md.digest())
        val mime = ctx.contentResolver.getType(uri) ?: "application/octet-stream"
        return obj(
            "t" to "file.offer", "fileId" to fileId, "name" to name, "size" to size, "mime" to mime, "sha256" to sha256,
            "chunkSize" to FileReceiver.CHUNK, "chunks" to (size + FileReceiver.CHUNK - 1) / FileReceiver.CHUNK, "ts" to System.currentTimeMillis(),
        )
    }

    /** Streams the chunks; [send] returns false when the channel is gone, [buffered] reports `bufferedAmount`. */
    fun stream(send: (ByteArray) -> Boolean, buffered: () -> Long, cancelled: () -> Boolean): Boolean {
        ctx.contentResolver.openInputStream(uri)?.use { input ->
            val buf = ByteArray(FileReceiver.CHUNK.toInt())
            var index = 0L
            while (!cancelled()) {
                var filled = 0
                while (filled < buf.size) {
                    val n = input.read(buf, filled, buf.size - filled)
                    if (n < 0) break
                    filled += n
                }
                if (filled == 0) return true
                while (buffered() > 1_048_576 && !cancelled()) Thread.sleep(20)
                if (!send(FileReceiver.chunk(fileId, index++, buf, filled))) return false
                if (filled < buf.size) return true
            }
        }
        return false
    }

    fun attestation(): OutboxEntry = OutboxEntry("file.sent", obj("fileId" to fileId, "direction" to "desk_to_assist", "name" to name, "bytes" to size, "sha256" to sha256))
}
