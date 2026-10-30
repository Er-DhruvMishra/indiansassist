package com.indiansassist.desk.core

import kotlinx.serialization.json.JsonObject

/** One `desk.event` waiting in the outbox. */
data class OutboxEntry(val action: String, val data: JsonObject, val reason: String? = null)

/**
 * The attestation outbox of B section 3.7 applied to the host (C section 3.8): one FIFO per session drained at 4 / s
 * with a burst of 15, entries are never dropped, only delayed; an `error rate_limited` re-queues the entry at the head
 * and halves the drain rate for 10 s; kept in memory only.
 */
class AttestOutbox(private val clock: () -> Long = System::currentTimeMillis) {
    private val queue = ArrayDeque<Pair<String, OutboxEntry>>()
    private val inFlight = LinkedHashMap<String, OutboxEntry>()
    private var seq = 0
    private var tokens = BURST
    private var last = clock()
    private var slowUntil = 0L

    val size: Int @Synchronized get() = queue.size

    @Synchronized
    fun add(e: OutboxEntry) {
        queue.addLast("ev${seq++}" to e)
    }

    /** Sends as many entries as the budget allows; [send] returns false when the socket is down (the entry stays). */
    @Synchronized
    fun drain(sessionId: String, send: (JsonObject) -> Boolean): Int {
        refill()
        var sent = 0
        while (queue.isNotEmpty() && tokens >= 1.0) {
            val (id, e) = queue.first()
            if (!send(DeskSignal.event(sessionId, e.action, e.data, id = id, reason = e.reason))) break
            queue.removeFirst()
            inFlight[id] = e
            while (inFlight.size > 64) inFlight.remove(inFlight.keys.first())
            tokens -= 1.0
            sent++
        }
        return sent
    }

    /** `error rate_limited { re }` for an entry: back to the head, half rate for 10 s. */
    @Synchronized
    fun rateLimited(re: String) {
        val e = inFlight.remove(re) ?: return
        queue.addFirst(re to e)
        slowUntil = clock() + 10_000
    }

    @Synchronized
    fun acked(re: String) {
        inFlight.remove(re)
    }

    private fun refill() {
        val now = clock()
        val rate = if (now < slowUntil) RATE / 2 else RATE
        tokens = minOf(BURST, tokens + (now - last) / 1000.0 * rate)
        last = now
    }

    companion object {
        const val RATE = 4.0
        const val BURST = 15.0
    }
}

/**
 * The `control.input` aggregate (C section 3.8): per 10 s window, `{ mode: 'os', monitorId: 1, count, kinds, windowMs,
 * textChars, refused }`, plus `input.text_burst` when `os.text` delivered more than 200 characters in the window.
 */
class InputAudit(private val clock: () -> Long = System::currentTimeMillis) {
    private var windowStart = clock()
    private var count = 0
    private var refused = 0
    private var textChars = 0
    private val kinds = LinkedHashSet<String>()

    @Synchronized
    fun op(kind: String) {
        count++
        kinds += kind
    }

    @Synchronized
    fun text(chars: Int) {
        textChars += chars
    }

    @Synchronized
    fun refused() {
        refused++
    }

    /** Closes the window when 10 s passed (or [force], before `session.end`); returns the entries to attest. */
    @Synchronized
    fun flush(force: Boolean = false): List<OutboxEntry> {
        val now = clock()
        val windowMs = now - windowStart
        if (!force && windowMs < WINDOW_MS) return emptyList()
        val out = mutableListOf<OutboxEntry>()
        if (count > 0 || refused > 0) {
            out += OutboxEntry(
                "control.input",
                obj("mode" to "os", "monitorId" to 1, "count" to count, "kinds" to kinds.toList(), "windowMs" to windowMs, "textChars" to textChars, "refused" to refused),
            )
        }
        if (textChars > TEXT_BURST_CHARS) out += OutboxEntry("input.text_burst", obj("chars" to textChars, "windowMs" to windowMs, "monitorId" to 1))
        windowStart = now
        count = 0
        refused = 0
        textChars = 0
        kinds.clear()
        return out
    }

    companion object {
        const val WINDOW_MS = 10_000L
        const val TEXT_BURST_CHARS = 200
    }
}
