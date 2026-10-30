package com.indiansassist.desk.service

import android.Manifest
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.provider.Settings
import com.indiansassist.desk.R
import com.indiansassist.desk.ui.MainActivity

/**
 * The non-negotiable indicator (contracts section 12.3): the persistent foreground-service notification "Sharing your
 * screen with <technician> (<org>)", importance HIGH, ongoing, with **Stop** and **View only**, the security code in
 * its expanded view; plus the accessibility off-boarding notifications of section 12.2.
 */
object Indicator {
    const val CHANNEL_SHARING = "ia.sharing"
    const val CHANNEL_A11Y = "ia.a11y"
    const val CHANNEL_A11Y_IDLE = "ia.a11y.idle"
    const val ID_SHARING = 1
    const val ID_A11Y_OFF = 2
    const val ID_A11Y_IDLE = 3

    /** Instrumented tests only: revoking POST_NOTIFICATIONS kills the process, so tests force the answer here. */
    @Volatile
    var testOverride: Boolean? = null

    fun createChannels(ctx: Context) {
        val nm = ctx.getSystemService(NotificationManager::class.java)
        nm.createNotificationChannel(NotificationChannel(CHANNEL_SHARING, "Screen sharing indicator", NotificationManager.IMPORTANCE_HIGH).apply {
            description = "Shown for the whole time your screen is shared. Required."
            setShowBadge(false)
        })
        nm.createNotificationChannel(NotificationChannel(CHANNEL_A11Y, "Turn off remote control", NotificationManager.IMPORTANCE_HIGH))
        nm.createNotificationChannel(NotificationChannel(CHANNEL_A11Y_IDLE, "Remote control is still on", NotificationManager.IMPORTANCE_LOW))
    }

    /** Section 12.3 precondition for **Share my screen**: notifications allowed and the indicator channel enabled. */
    fun usable(ctx: Context): Boolean {
        testOverride?.let { return it }
        val nm = ctx.getSystemService(NotificationManager::class.java)
        if (Build.VERSION.SDK_INT >= 33 && ctx.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) return false
        if (!nm.areNotificationsEnabled()) return false
        val ch = nm.getNotificationChannel(CHANNEL_SHARING) ?: return false
        return ch.importance != NotificationManager.IMPORTANCE_NONE
    }

    fun sharing(ctx: Context, technician: String, org: String, sas: String?, recording: Boolean, level: String): Notification {
        val open = PendingIntent.getActivity(ctx, 0, Intent(ctx, MainActivity::class.java), PendingIntent.FLAG_IMMUTABLE)
        val stop = PendingIntent.getService(ctx, 1, Intent(ctx, SessionService::class.java).setAction(SessionService.ACTION_STOP), PendingIntent.FLAG_IMMUTABLE)
        val view = PendingIntent.getService(ctx, 2, Intent(ctx, SessionService::class.java).setAction(SessionService.ACTION_VIEW_ONLY), PendingIntent.FLAG_IMMUTABLE)
        val who = if (org.isBlank()) technician else "$technician ($org)"
        val code = sas?.let { "Security code $it. If the two codes differ, stop the session." } ?: "Securing the connection..."
        val detail = buildString {
            append(code)
            append(if (level == "control") "\nThe technician can tap and type." else "\nView only.")
            if (recording) append("\nThis session is being recorded.")
        }
        val b = Notification.Builder(ctx, CHANNEL_SHARING)
            .setSmallIcon(R.drawable.ic_stat_share)
            .setContentTitle("Sharing your screen with $who")
            .setContentText(code)
            .setStyle(Notification.BigTextStyle().bigText(detail))
            .setOngoing(true)
            .setCategory(Notification.CATEGORY_CALL)
            .setContentIntent(open)
            .addAction(Notification.Action.Builder(null, "Stop", stop).build())
        if (level == "control") b.addAction(Notification.Action.Builder(null, "View only", view).build())
        if (Build.VERSION.SDK_INT >= 31) b.setForegroundServiceBehavior(Notification.FOREGROUND_SERVICE_IMMEDIATE)
        return b.build().apply { flags = flags or Notification.FLAG_NO_CLEAR or Notification.FLAG_ONGOING_EVENT }
    }

    /** At `session.ended` while the service is still on: not dismissable until acted on (section 12.2). */
    fun a11yTurnOff(ctx: Context) {
        val nm = ctx.getSystemService(NotificationManager::class.java)
        val settings = PendingIntent.getActivity(ctx, 3, Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK), PendingIntent.FLAG_IMMUTABLE)
        nm.notify(ID_A11Y_OFF, Notification.Builder(ctx, CHANNEL_A11Y)
            .setSmallIcon(R.drawable.ic_stat_share)
            .setContentTitle("Turn off accessibility for IndiansAssist")
            .setContentText("The session has ended. Open Settings and switch off IndiansAssist remote control.")
            .setOngoing(true)
            .setAutoCancel(true)
            .setContentIntent(settings)
            .build())
    }

    /** While the service is enabled with no session: low-priority persistent reminder (Play prominent disclosure). */
    fun a11yIdle(ctx: Context, enabled: Boolean) {
        val nm = ctx.getSystemService(NotificationManager::class.java)
        if (!enabled) {
            nm.cancel(ID_A11Y_IDLE)
            nm.cancel(ID_A11Y_OFF)
            return
        }
        val settings = PendingIntent.getActivity(ctx, 4, Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK), PendingIntent.FLAG_IMMUTABLE)
        nm.notify(ID_A11Y_IDLE, Notification.Builder(ctx, CHANNEL_A11Y_IDLE)
            .setSmallIcon(R.drawable.ic_stat_share)
            .setContentTitle("IndiansAssist remote control is on")
            .setContentText("It does nothing outside a session. Tap to turn it off.")
            .setOngoing(true)
            .setContentIntent(settings)
            .build())
    }
}
