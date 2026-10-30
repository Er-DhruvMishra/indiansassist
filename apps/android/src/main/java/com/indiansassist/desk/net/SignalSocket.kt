package com.indiansassist.desk.net

import com.indiansassist.desk.core.DeskMachine
import com.indiansassist.desk.core.Wire
import kotlinx.serialization.json.JsonObject
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import java.util.concurrent.Executors
import java.util.concurrent.ScheduledFuture
import java.util.concurrent.TimeUnit

/**
 * The `/signal` client (contracts sections 3.1 and 12.5): OkHttp WebSocket with the host's User-Agent and **no**
 * `Origin` header, text JSON frames only, reconnect with backoff 1, 2, 4, 8 s capped at 30 s unless the close code
 * is terminal (4401, 4403, 4409, 4410, 4411). The owner re-sends `desk.hello` with the resumeKey on every open.
 */
class SignalSocket(
    private val url: String,
    private val userAgent: String,
    private val listener: Listener,
    private val http: OkHttpClient = OkHttpClient.Builder().pingInterval(0, TimeUnit.SECONDS).build(),
) {
    interface Listener {
        fun onOpen(reconnect: Boolean)
        fun onMessage(msg: JsonObject)
        fun onClosed(code: Int)
    }

    private val timer = Executors.newSingleThreadScheduledExecutor { Thread(it, "ia-signal-retry").apply { isDaemon = true } }
    private var ws: WebSocket? = null
    private var attempt = 0
    private var opened = false
    @Volatile private var closedByOwner = false
    private var retry: ScheduledFuture<*>? = null

    val isOpen: Boolean @Synchronized get() = ws != null

    @Synchronized
    fun connect() {
        closedByOwner = false
        open()
    }

    @Synchronized
    private fun open() {
        val req = Request.Builder().url(url).header("User-Agent", userAgent).build()
        val socket = http.newWebSocket(req, object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) {
                val reconnect: Boolean
                synchronized(this@SignalSocket) {
                    if (ws !== webSocket) return
                    reconnect = opened
                    opened = true
                    attempt = 0
                }
                listener.onOpen(reconnect)
            }

            override fun onMessage(webSocket: WebSocket, text: String) {
                if (ws !== webSocket) return
                Wire.parseObject(text)?.let { listener.onMessage(it) }
            }

            override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
                webSocket.close(code, null)
                closed(webSocket, code)
            }

            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) = closed(webSocket, 1006)
        })
        ws = socket
    }

    private fun closed(socket: WebSocket, code: Int) {
        synchronized(this) {
            if (ws !== socket) return
            ws = null
        }
        listener.onClosed(code)
        if (!closedByOwner && code !in DeskMachine.TERMINAL_CLOSES) scheduleReconnect()
    }

    @Synchronized
    private fun scheduleReconnect() {
        if (retry != null) return
        val delay = backoffMs(attempt++)
        retry = timer.schedule({
            synchronized(this) {
                retry = null
                if (!closedByOwner) open()
            }
        }, delay, TimeUnit.MILLISECONDS)
    }

    /** Sends now when open; false (frame not sent) otherwise. */
    fun send(msg: JsonObject): Boolean {
        val s = synchronized(this) { ws } ?: return false
        return s.send(Wire.encode(msg))
    }

    @Synchronized
    fun close(code: Int = 1000) {
        closedByOwner = true
        retry?.cancel(false)
        retry = null
        ws?.close(code, null)
        ws = null
        timer.shutdownNow()
    }

    companion object {
        /** 1, 2, 4, 8, 16 s, then 30 s. */
        fun backoffMs(attempt: Int): Long = minOf(30_000L, 1000L shl minOf(attempt, 5))
    }
}
