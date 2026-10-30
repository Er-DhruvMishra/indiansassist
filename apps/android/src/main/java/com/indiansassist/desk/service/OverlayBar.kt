package com.indiansassist.desk.service

import android.annotation.SuppressLint
import android.content.Context
import android.graphics.Color
import android.graphics.PixelFormat
import android.graphics.Rect
import android.provider.Settings
import android.view.Gravity
import android.view.MotionEvent
import android.view.View
import android.view.WindowManager
import android.widget.Button
import android.widget.LinearLayout
import android.widget.TextView
import com.indiansassist.desk.core.DispatchWindows

/**
 * The thin always-on-top bar (section 12.3, additive to the notification): technician, security code, recording dot
 * and **Stop**. It filters obscured touches and ignores touches that fall inside a dispatched gesture window, and the
 * Accessibility service refuses gestures aimed at its [bounds].
 */
class OverlayBar(private val ctx: Context, private val onStop: () -> Unit) {
    private val wm = ctx.getSystemService(WindowManager::class.java)
    private var root: LinearLayout? = null
    private var label: TextView? = null

    fun canShow() = Settings.canDrawOverlays(ctx)

    @SuppressLint("ClickableViewAccessibility")
    fun show() {
        if (root != null || !canShow()) return
        val text = TextView(ctx).apply { setTextColor(Color.WHITE); textSize = 13f; setPadding(24, 8, 16, 8) }
        val stop = Button(ctx).apply {
            this.text = "Stop"
            setBackgroundColor(Color.parseColor("#B91C1C"))
            setTextColor(Color.WHITE)
            minimumHeight = 0
            minHeight = (44 * ctx.resources.displayMetrics.density).toInt()
            filterTouchesWhenObscured = true
            setOnTouchListener { _, ev -> ev.action == MotionEvent.ACTION_DOWN && DispatchWindows.isInjected(ev.eventTime) }
            setOnClickListener { onStop() }
        }
        val bar = LinearLayout(ctx).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            setBackgroundColor(Color.parseColor("#E60F766E"))
            filterTouchesWhenObscured = true
            addView(text, LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f))
            addView(stop)
        }
        val lp = WindowManager.LayoutParams(
            WindowManager.LayoutParams.MATCH_PARENT, WindowManager.LayoutParams.WRAP_CONTENT,
            WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY,
            WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN,
            PixelFormat.TRANSLUCENT,
        ).apply { gravity = Gravity.TOP }
        wm.addView(bar, lp)
        bar.addOnLayoutChangeListener { v, _, _, _, _, _, _, _, _ ->
            val loc = IntArray(2)
            v.getLocationOnScreen(loc)
            bounds = Rect(loc[0], loc[1], loc[0] + v.width, loc[1] + v.height)
        }
        root = bar
        label = text
    }

    fun update(technician: String, sas: String?, recording: Boolean) {
        label?.text = buildString {
            if (recording) append("● REC  ")
            append("Sharing with ").append(technician)
            append(sas?.let { "  |  Code $it" } ?: "  |  Securing...")
        }
    }

    val isShown: Boolean get() = root != null

    fun hide() {
        root?.let { v -> try { wm.removeView(v) } catch (_: Exception) {} }
        root = null
        label = null
        bounds = null
    }

    companion object {
        /** Screen rect of the bar while shown (read by the Accessibility service). */
        @Volatile
        var bounds: Rect? = null
            private set
    }
}
