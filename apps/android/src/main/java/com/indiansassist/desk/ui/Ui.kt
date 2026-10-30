package com.indiansassist.desk.ui

import android.annotation.SuppressLint
import android.content.Context
import android.graphics.Color
import android.graphics.Typeface
import android.view.MotionEvent
import android.view.View
import android.view.ViewGroup
import android.widget.Button
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import com.indiansassist.desk.core.DispatchWindows

/** Small programmatic view helpers (the app has a handful of plain screens and no layout XML). */
object Ui {
    const val TEAL = "#0F766E"
    const val RED = "#B91C1C"

    fun dp(ctx: Context, v: Int) = (v * ctx.resources.displayMetrics.density).toInt()

    fun column(ctx: Context): LinearLayout = LinearLayout(ctx).apply {
        orientation = LinearLayout.VERTICAL
        val p = dp(ctx, 20)
        setPadding(p, p, p, p)
    }

    /** Root scroller; pads for the system bars (target SDK 35+ draws edge to edge). */
    fun scroll(ctx: Context, child: View): ScrollView = ScrollView(ctx).apply {
        isFillViewport = true
        setBackgroundColor(Color.parseColor("#FAFAFA"))
        addView(child)
        setOnApplyWindowInsetsListener { v, insets ->
            if (android.os.Build.VERSION.SDK_INT >= 30) {
                val bars = insets.getInsets(android.view.WindowInsets.Type.systemBars() or android.view.WindowInsets.Type.ime())
                v.setPadding(bars.left, bars.top, bars.right, bars.bottom)
            } else {
                // Android 10 (min SDK 29): WindowInsets.Type does not exist; the system-window insets include the IME.
                @Suppress("DEPRECATION")
                v.setPadding(insets.systemWindowInsetLeft, insets.systemWindowInsetTop, insets.systemWindowInsetRight, insets.systemWindowInsetBottom)
            }
            insets
        }
    }

    fun title(ctx: Context, text: String) = TextView(ctx).apply {
        this.text = text
        textSize = 22f
        setTypeface(typeface, Typeface.BOLD)
        setTextColor(Color.parseColor("#111827"))
        setPadding(0, 0, 0, dp(ctx, 12))
    }

    fun body(ctx: Context, text: String, size: Float = 16f) = TextView(ctx).apply {
        this.text = text
        textSize = size
        setTextColor(Color.parseColor("#1F2937"))
        setPadding(0, dp(ctx, 4), 0, dp(ctx, 8))
    }

    fun button(ctx: Context, text: String, color: String = TEAL, onClick: () -> Unit) = Button(ctx).apply {
        this.text = text
        isAllCaps = false
        textSize = 16f
        setTextColor(Color.WHITE)
        setBackgroundColor(Color.parseColor(color))
        minHeight = dp(ctx, 48)
        setOnClickListener { onClick() }
        layoutParams = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply { topMargin = dp(ctx, 8) }
    }

    /**
     * Prompt self-defence (section 12.3): obscured touches are filtered, and a touch whose timestamp falls inside a
     * dispatched gesture window (+150 ms) is swallowed, so the technician's injected tap cannot press this view.
     */
    @SuppressLint("ClickableViewAccessibility")
    fun <T : View> guard(v: T): T = v.apply {
        filterTouchesWhenObscured = true
        setOnTouchListener { _, ev -> isInjected(ev) }
    }

    fun isInjected(ev: MotionEvent): Boolean = DispatchWindows.isInjected(ev.eventTime)
}
