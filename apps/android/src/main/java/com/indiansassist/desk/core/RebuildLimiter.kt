package com.indiansassist.desk.core

/**
 * Caps channel-triggered secure-channel rebuilds (contracts section 1.3 channel-lifetime rule, C15): at most [cap]
 * rebuilds within a sliding [windowMs]. Without a cap a signaling server that keeps closing an encrypted channel
 * drives an unbounded, unaudited rebuild loop; the caller chains `desk.event sec.failed{reason:'channel'}` on each
 * allowed rebuild and ends the session (step 9) once [allow] returns false.
 */
class RebuildLimiter(
    private val cap: Int = 3,
    private val windowMs: Long = 600_000L,
    private val clock: () -> Long = System::currentTimeMillis,
) {
    private val times = ArrayDeque<Long>()

    /** Records a rebuild attempt; returns true when it is under the cap for the current window, false otherwise. */
    @Synchronized
    fun allow(): Boolean {
        val now = clock()
        while (times.isNotEmpty() && now - times.first() > windowMs) times.removeFirst()
        if (times.size >= cap) return false
        times.addLast(now)
        return true
    }
}
