package com.indiansassist.desk

import android.app.Activity
import android.app.Application
import android.os.Bundle
import com.indiansassist.desk.service.Indicator
import com.indiansassist.desk.session.SessionHub

/** Creates the notification channels and tracks whether one of the app's own activities is in front. */
class DeskApp : Application() {
    override fun onCreate() {
        super.onCreate()
        Indicator.createChannels(this)
        registerActivityLifecycleCallbacks(object : ActivityLifecycleCallbacks {
            private var resumed = 0
            override fun onActivityResumed(activity: Activity) {
                resumed++
                SessionHub.ownWindowInFront(true)
            }
            override fun onActivityPaused(activity: Activity) {
                resumed = (resumed - 1).coerceAtLeast(0)
                SessionHub.ownWindowInFront(resumed > 0)
            }
            override fun onActivityCreated(activity: Activity, savedInstanceState: Bundle?) {}
            override fun onActivityStarted(activity: Activity) {}
            override fun onActivityStopped(activity: Activity) {}
            override fun onActivitySaveInstanceState(activity: Activity, outState: Bundle) {}
            override fun onActivityDestroyed(activity: Activity) {}
        })
    }
}
