package com.indiansassist.desk.net

import com.indiansassist.desk.core.DeskMachine
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/** Section 3.1 reconnect backoff 1, 2, 4, 8 s, max 30 s, and the terminal close codes. */
class BackoffTest {
    @Test
    fun backoffSequence() {
        assertEquals(listOf(1000L, 2000L, 4000L, 8000L, 16000L, 30000L, 30000L), (0..6).map { SignalSocket.backoffMs(it) })
    }

    @Test
    fun terminalCloses() {
        assertTrue(DeskMachine.TERMINAL_CLOSES.containsAll(listOf(4401, 4403, 4409, 4410, 4411)))
        assertTrue(1006 !in DeskMachine.TERMINAL_CLOSES)
    }
}
