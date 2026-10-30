package com.indiansassist.desk.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** `os.text` insertion splicing, the InputGuard state table, dispatch windows and the token bucket. */
class InputRulesTest {
    @Test
    fun twoFlushesReadHello() {
        val a = TextEditing.insert("", 0, 0, "hel")
        val b = TextEditing.insert(a.text, a.caret, a.caret, "lo")
        assertEquals(TextEdit("hello", 5), b)
    }

    @Test
    fun insertionReplacesSelectionAndHonoursCaret() {
        assertEquals(TextEdit("say hi there", 7), TextEditing.insert("say there", 4, 4, "hi "))
        assertEquals(TextEdit("a-X-c", 3), TextEditing.insert("a-b-c", 2, 3, "X"))
        assertEquals(TextEdit("a-X-c", 3), TextEditing.insert("a-b-c", 3, 2, "X")) // reversed selection
        assertEquals(TextEdit("abcde", 5), TextEditing.insert("abc", -1, -1, "de")) // no selection: append
        assertEquals(TextEdit("abcX", 4), TextEditing.insert("abc", 99, 99, "X")) // clamped
    }

    @Test
    fun backspaceAndDeleteWorkOnCodePoints() {
        assertEquals(TextEdit("ab", 2), TextEditing.backspace("abc", 3, 3))
        assertEquals(TextEdit("a", 1), TextEditing.backspace("a😀", 3, 3))
        assertEquals(TextEdit("ac", 1), TextEditing.backspace("abc", 1, 2))
        assertNull(TextEditing.backspace("abc", 0, 0))
        assertEquals(TextEdit("bc", 0), TextEditing.delete("abc", 0, 0))
        assertEquals(TextEdit("a", 1), TextEditing.delete("a😀", 1, 1))
        assertNull(TextEditing.delete("abc", 3, 3))
    }

    @Test
    fun inputGuardStateTable() {
        for (active in listOf(true, false)) for (level in listOf("view", "control", "elevated")) for (est in listOf(true, false)) for (prompt in listOf(true, false)) {
            val want = active && est && !prompt && level != "view"
            assertEquals("$active $level $est $prompt", want, InputGuard.allow(GuardState(active, level, est, prompt)))
        }
        assertFalse(InputGuard().allow()) // closed by default: outside a session the service exposes nothing
    }

    @Test
    fun dispatchWindowsCoverDurationPlus150ms() {
        DispatchWindows.clear()
        DispatchWindows.record(1_000, 50)
        assertTrue(DispatchWindows.isInjected(1_000))
        assertTrue(DispatchWindows.isInjected(1_200))
        assertFalse(DispatchWindows.isInjected(1_201))
        assertFalse(DispatchWindows.isInjected(999))
        DispatchWindows.clear()
    }

    @Test
    fun tokenBucketRefills() {
        var now = 0L
        val b = TokenBucket(30.0, 60.0) { now }
        repeat(60) { assertTrue(b.tryTake()) }
        assertFalse(b.tryTake())
        now = 100
        repeat(3) { assertTrue(b.tryTake()) }
        assertFalse(b.tryTake())
    }
}
