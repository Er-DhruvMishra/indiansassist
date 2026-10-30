package com.indiansassist.desk.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** Section 12.4 op -> gesture mapping: taps, long press, double tap, the scroll notch rule, stroke continuation. */
class GestureMappingTest {
    private val g = GestureMapper(1080, 2400)

    @Test
    fun tapIsScaledAndClamped() {
        val s = g.tap(0.5, 0.25).strokes.single()
        assertEquals(listOf(Pt(540f, 600f)), s.points)
        assertEquals(GestureMapper.TAP_MS, s.durationMs)
        assertEquals(Pt(1079f, 2399f), g.tap(1.0, 1.0).strokes.single().points.single())
    }

    @Test
    fun longPressAndDoubleTap() {
        assertEquals(600L, g.longPress(0.1, 0.1).strokes.single().durationMs)
        val d = g.doubleTap(0.2, 0.2).strokes
        assertEquals(2, d.size)
        assertEquals(0L, d[0].startMs)
        assertTrue(d[1].startMs > d[0].startMs + d[0].durationMs)
    }

    @Test
    fun scrollNotchRuleInvertedAndCapped() {
        // One notch = 10 % of the shorter side (108 px); positive dy (scroll down) moves the finger up.
        val down = g.scroll(0.5, 0.5, 0, 1)!!.strokes.single()
        assertEquals(Pt(540f, 1200f), down.points[0])
        assertEquals(Pt(540f, 1092f), down.points[1])
        assertEquals(150L, down.durationMs)
        val up3 = g.scroll(0.5, 0.5, 0, -3)!!.strokes.single()
        assertEquals(1200f + 3 * 108f, up3.points[1].y, 0.01f)
        // At most 5 notches per op.
        val capped = g.scroll(0.5, 0.5, 0, 20)!!.strokes.single()
        assertEquals(1200f - 5 * 108f, capped.points[1].y, 0.01f)
        // Horizontal: positive dx moves the finger left; clamped to the display.
        val right = g.scroll(0.05, 0.5, 5, 0)!!.strokes.single()
        assertEquals(0f, right.points[1].x, 0.01f)
        assertNull(g.scroll(0.5, 0.5, 0, 0))
    }

    @Test
    fun dragContinuesTheStrokeAt20Hz() {
        var now = 1_000L
        val t = StrokeTracker { now }
        assertEquals(listOf(StrokeCommand.Begin(Pt(10f, 10f))), t.down(Pt(10f, 10f)))
        now += 10
        assertTrue(t.move(Pt(20f, 20f)).isEmpty()) // coalesced: less than 50 ms since the last segment
        now += 10
        assertTrue(t.move(Pt(30f, 30f)).isEmpty()) // replaces the unsent move
        now += 40
        val tick = t.tick()
        assertEquals(listOf(StrokeCommand.Continue(Pt(10f, 10f), Pt(30f, 30f), 50, willContinue = true)), tick)
        now += 60
        assertEquals(listOf(StrokeCommand.Continue(Pt(30f, 30f), Pt(40f, 40f), 50, willContinue = true)), t.move(Pt(40f, 40f)))
        val up = t.up(Pt(50f, 50f))
        assertEquals(listOf(StrokeCommand.Continue(Pt(40f, 40f), Pt(50f, 50f), 50, willContinue = false)), up)
        assertFalse(t.isActive)
    }

    @Test
    fun strokeReaching55sIsSplitAtTheSamePoint() {
        var now = 0L
        val t = StrokeTracker { now }
        t.down(Pt(1f, 1f))
        // Keep it alive with moves every second for 55 s.
        var split = emptyList<StrokeCommand>()
        for (i in 1..55) {
            now = i * 1000L
            val out = t.move(Pt(1f + i, 1f))
            if (out.any { it is StrokeCommand.Begin }) split = out
        }
        assertTrue("expected a lift-and-replace at 55 s", split.isNotEmpty())
        val end = split.first() as StrokeCommand.Continue
        assertFalse(end.willContinue)
        assertEquals(end.to, (split[1] as StrokeCommand.Begin).at)
        assertTrue(t.isActive)
    }

    @Test
    fun danglingStrokeEndsAfter2s() {
        var now = 0L
        val t = StrokeTracker { now }
        t.down(Pt(5f, 5f))
        now = 1_999
        assertTrue(t.tick().isEmpty())
        now = 2_000
        val out = t.tick().single() as StrokeCommand.Continue
        assertFalse(out.willContinue)
        assertFalse(t.isActive)
    }

    @Test
    fun secondDownEndsTheFirstStroke() {
        val t = StrokeTracker { 0L }
        t.down(Pt(1f, 1f))
        val out = t.down(Pt(2f, 2f))
        assertFalse((out[0] as StrokeCommand.Continue).willContinue)
        assertEquals(StrokeCommand.Begin(Pt(2f, 2f)), out[1])
    }
}
