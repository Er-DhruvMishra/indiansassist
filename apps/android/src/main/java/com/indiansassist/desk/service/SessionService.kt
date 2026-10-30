package com.indiansassist.desk.service

import android.Manifest
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.content.pm.ServiceInfo
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import com.indiansassist.desk.net.ResolvedToken
import com.indiansassist.desk.session.SessionHub
import com.indiansassist.desk.ui.ConsentActivity
import com.indiansassist.desk.ui.MainActivity
import com.indiansassist.desk.ui.PromptActivity

/**
 * Holds the session for its whole life (section 12.2 persistence): a started service while waiting, promoted to a
 * foreground service of type `mediaProjection` (plus `microphone` when granted) once the user consents, with the
 * non-dismissable sharing notification as the indicator. MediaProjection and the peers live here, so backgrounding
 * the app keeps sharing.
 */
class SessionService : Service() {
    private val main = Handler(Looper.getMainLooper())
    private var controller: DeskController? = null
    private var overlay: OverlayBar? = null
    private var foreground = false

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_JOIN -> if (controller == null) {
                val t = ResolvedToken(
                    intent.getStringExtra(EXTRA_CODE) ?: return START_NOT_STICKY,
                    intent.getStringExtra(EXTRA_API) ?: "",
                    intent.getStringExtra(EXTRA_SIGNAL) ?: return START_NOT_STICKY,
                    "p3_portable",
                    intent.getStringExtra(EXTRA_TECH),
                    intent.getStringExtra(EXTRA_ORG) ?: "",
                )
                SessionHub.reset()
                controller = DeskController(this, t, intent.getStringExtra(EXTRA_SOURCE) ?: "manual", intent.getStringExtra(EXTRA_LABEL)).also { it.start() }
            }
            ACTION_STOP -> SessionHub.commands?.stop()
            ACTION_VIEW_ONLY -> SessionHub.commands?.viewOnly()
        }
        return START_NOT_STICKY
    }

    /** Called before `getMediaProjection` (Android 14 ties the projection to a foreground service started first). */
    fun goForeground() {
        if (foreground) return
        val s = SessionHub.state.value
        val n = Indicator.sharing(this, s.technician ?: "your technician", s.org ?: "", s.sas, s.recording, s.level)
        var type = ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION
        if (android.os.Build.VERSION.SDK_INT >= 30 && checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED) type = type or ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE
        startForeground(Indicator.ID_SHARING, n, type)
        foreground = true
    }

    fun refreshIndicator() = main.post {
        val s = SessionHub.state.value
        if (foreground) {
            getSystemService(android.app.NotificationManager::class.java)
                .notify(Indicator.ID_SHARING, Indicator.sharing(this, s.technician ?: "your technician", s.org ?: "", s.sas, s.recording, s.level))
        }
        overlay?.update(s.technician ?: "your technician", s.sas, s.recording)
    }

    fun showConsent() = main.post {
        startActivity(Intent(this, ConsentActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
    }

    fun showPrompt() = main.post {
        startActivity(Intent(this, PromptActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
    }

    fun showOverlay() = main.post {
        if (overlay == null) overlay = OverlayBar(this) { SessionHub.commands?.stop() }
        overlay?.show()
    }

    /** A loss of `canDrawOverlays()` mid-session shows an in-app full-screen reminder (section 12.3). */
    fun checkOverlay() = main.post {
        val o = overlay ?: return@post
        if (o.isShown && !o.canShow()) {
            o.hide()
            startActivity(Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK).putExtra(MainActivity.EXTRA_OVERLAY_LOST, true))
        }
    }

    fun mediaStopped() = main.post {
        overlay?.hide()
        overlay = null
    }

    fun finish() = main.post {
        overlay?.hide()
        overlay = null
        if (foreground) stopForeground(STOP_FOREGROUND_REMOVE)
        foreground = false
        controller = null
        stopSelf()
    }

    override fun onDestroy() {
        overlay?.hide()
        SessionHub.commands?.stop()
        super.onDestroy()
    }

    companion object {
        const val ACTION_JOIN = "com.indiansassist.desk.JOIN"
        const val ACTION_STOP = "com.indiansassist.desk.STOP"
        const val ACTION_VIEW_ONLY = "com.indiansassist.desk.VIEW_ONLY"
        private const val EXTRA_CODE = "code"
        private const val EXTRA_API = "api"
        private const val EXTRA_SIGNAL = "signal"
        private const val EXTRA_TECH = "tech"
        private const val EXTRA_ORG = "org"
        private const val EXTRA_SOURCE = "source"
        private const val EXTRA_LABEL = "label"

        fun join(ctx: Context, t: ResolvedToken, tokenSource: String, deskLabel: String?) {
            ctx.startService(
                Intent(ctx, SessionService::class.java).setAction(ACTION_JOIN)
                    .putExtra(EXTRA_CODE, t.code).putExtra(EXTRA_API, t.apiOrigin).putExtra(EXTRA_SIGNAL, t.signalUrl)
                    .putExtra(EXTRA_TECH, t.technician).putExtra(EXTRA_ORG, t.org).putExtra(EXTRA_SOURCE, tokenSource).putExtra(EXTRA_LABEL, deskLabel),
            )
        }
    }
}
