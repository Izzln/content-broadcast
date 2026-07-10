package app.contentbroadcast.tv

import android.os.Handler
import android.os.Looper
import android.util.Log
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import org.json.JSONObject
import java.util.concurrent.TimeUnit

/**
 * Persistent WebSocket connection to the server's device hub.
 * Reconnects with backoff; delivers commands on the main thread.
 */
class ControlClient(
    private val wsUrl: String,
    private val deviceId: String,
    private val deviceName: String,
    private val listener: Listener,
) {
    interface Listener {
        fun onPlay(url: String, title: String)
        fun onStop()
        fun onConnectionChanged(connected: Boolean)
    }

    private val client = OkHttpClient.Builder()
        .pingInterval(15, TimeUnit.SECONDS)
        .build()
    private val main = Handler(Looper.getMainLooper())
    private var socket: WebSocket? = null
    private var closed = false
    private var backoffMs = 2_000L

    fun start() {
        closed = false
        connect()
    }

    fun stop() {
        closed = true
        socket?.close(1000, "bye")
        socket = null
    }

    fun sendStatus(state: String, detail: String? = null) {
        val msg = JSONObject().put("type", "status").put("state", state)
        if (detail != null) msg.put("detail", detail)
        socket?.send(msg.toString())
    }

    fun sendEnded() {
        socket?.send(JSONObject().put("type", "ended").toString())
    }

    private fun connect() {
        if (closed) return
        val request = Request.Builder().url(wsUrl).build()
        client.newWebSocket(request, object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) {
                socket = webSocket
                backoffMs = 2_000L
                webSocket.send(
                    JSONObject()
                        .put("type", "hello")
                        .put("deviceId", deviceId)
                        .put("name", deviceName)
                        .toString(),
                )
                main.post { listener.onConnectionChanged(true) }
            }

            override fun onMessage(webSocket: WebSocket, text: String) {
                val msg = try {
                    JSONObject(text)
                } catch (e: Exception) {
                    return
                }
                when (msg.optString("type")) {
                    "play" -> {
                        val url = msg.optString("url")
                        val title = msg.optString("title", url)
                        if (url.isNotEmpty()) main.post { listener.onPlay(url, title) }
                    }
                    "stop" -> main.post { listener.onStop() }
                    "ping" -> webSocket.send(JSONObject().put("type", "pong").toString())
                }
            }

            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                Log.w(TAG, "ws failure: ${t.message}")
                onDisconnected()
            }

            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                onDisconnected()
            }
        })
    }

    private fun onDisconnected() {
        socket = null
        main.post { listener.onConnectionChanged(false) }
        if (closed) return
        main.postDelayed({ connect() }, backoffMs)
        backoffMs = (backoffMs * 2).coerceAtMost(30_000L)
    }

    companion object {
        private const val TAG = "ControlClient"
    }
}
