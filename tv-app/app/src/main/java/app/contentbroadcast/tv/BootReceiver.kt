package app.contentbroadcast.tv

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

/** Relaunch the player automatically after the TV powers on. */
class BootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != Intent.ACTION_BOOT_COMPLETED) return
        if (Prefs.server(context) == null) return // not paired yet
        val launch = Intent(context, PlayerActivity::class.java).apply {
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        }
        context.startActivity(launch)
    }
}
