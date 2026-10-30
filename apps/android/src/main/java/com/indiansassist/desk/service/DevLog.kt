package com.indiansassist.desk.service

import android.util.Log
import com.indiansassist.desk.BuildConfig
import com.indiansassist.desk.core.bool
import com.indiansassist.desk.core.objOrNull
import com.indiansassist.desk.core.str
import kotlinx.serialization.json.JsonObject

/**
 * Debug-build-only diagnostics read by the live emulator e2e (tools/android-e2e.mjs, `adb logcat -s IA.ctl IA.a11y`):
 * the outcome of every `ia.control` request (op, pointer kind, id, ok / error code; never coordinates or text) and every
 * `dispatchGesture` result. Release builds (`DEV = false`) log nothing.
 */
object DevLog {
    private const val CTL = "IA.ctl"
    private const val A11Y = "IA.a11y"

    fun control(op: String, id: String, res: JsonObject, kind: String? = null) {
        if (!BuildConfig.DEV) return
        val ok = res.bool("ok") == true
        Log.i(CTL, "ctl.res op=$op${kind?.let { " kind=$it" } ?: ""} id=$id ok=$ok${if (ok) "" else " error=${res.objOrNull("error")?.str("code")}"}")
    }

    fun gesture(kind: String, accepted: Boolean, result: String, strokes: Int, durationMs: Long) {
        if (!BuildConfig.DEV) return
        Log.i(A11Y, "dispatchGesture kind=$kind accepted=$accepted result=$result strokes=$strokes durationMs=$durationMs")
    }
}
