package app.contentbroadcast.tv

import android.content.Context
import android.os.Build
import java.util.UUID

/** Persisted device identity and server address. */
object Prefs {
    private const val FILE = "content_broadcast"
    private const val KEY_SERVER = "server" // host:port
    private const val KEY_DEVICE_ID = "device_id"

    fun server(context: Context): String? =
        context.getSharedPreferences(FILE, Context.MODE_PRIVATE)
            .getString(KEY_SERVER, null)

    fun setServer(context: Context, hostPort: String) {
        context.getSharedPreferences(FILE, Context.MODE_PRIVATE)
            .edit().putString(KEY_SERVER, hostPort).apply()
    }

    fun deviceId(context: Context): String {
        val prefs = context.getSharedPreferences(FILE, Context.MODE_PRIVATE)
        var id = prefs.getString(KEY_DEVICE_ID, null)
        if (id == null) {
            id = UUID.randomUUID().toString()
            prefs.edit().putString(KEY_DEVICE_ID, id).apply()
        }
        return id
    }

    fun deviceName(): String = "${Build.MANUFACTURER} ${Build.MODEL}".trim()

    /** Base HTTP URL of the server, e.g. http://192.168.1.10:8080 */
    fun httpBase(context: Context): String? = server(context)?.let { "http://$it" }

    /** WebSocket URL of the server's device hub. */
    fun wsUrl(context: Context): String? = server(context)?.let { "ws://$it/ws" }
}
