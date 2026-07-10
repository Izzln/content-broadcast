package app.contentbroadcast.tv

import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.view.View
import android.view.WindowManager
import android.widget.TextView
import androidx.appcompat.app.AppCompatActivity
import androidx.media3.common.MediaItem
import androidx.media3.common.PlaybackException
import androidx.media3.common.Player
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.ui.PlayerView

/** Fullscreen kiosk player driven entirely by server commands. */
class PlayerActivity : AppCompatActivity(), ControlClient.Listener {

    private lateinit var playerView: PlayerView
    private lateinit var statusText: TextView
    private var player: ExoPlayer? = null
    private var control: ControlClient? = null
    private val main = Handler(Looper.getMainLooper())
    private var currentUrl: String? = null
    private var currentTitle: String = ""
    private val retryPlayback = Runnable { currentUrl?.let { startPlayback(it, currentTitle) } }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_player)
        playerView = findViewById(R.id.player_view)
        statusText = findViewById(R.id.status_text)
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        showStatus(getString(R.string.connecting, Prefs.server(this) ?: ""))
    }

    override fun onStart() {
        super.onStart()
        enterImmersiveMode()
        initPlayer()
        val wsUrl = Prefs.wsUrl(this) ?: return finish()
        control = ControlClient(wsUrl, Prefs.deviceId(this), Prefs.deviceName(), this).also {
            it.start()
        }
    }

    override fun onStop() {
        super.onStop()
        control?.stop()
        control = null
        main.removeCallbacks(retryPlayback)
        player?.release()
        player = null
    }

    private fun initPlayer() {
        val exo = ExoPlayer.Builder(this).build()
        player = exo
        playerView.player = exo
        playerView.useController = false
        exo.playWhenReady = true
        exo.addListener(object : Player.Listener {
            override fun onPlaybackStateChanged(playbackState: Int) {
                when (playbackState) {
                    Player.STATE_READY -> {
                        hideStatus()
                        control?.sendStatus("playing")
                    }
                    Player.STATE_BUFFERING -> control?.sendStatus("buffering")
                    Player.STATE_ENDED -> {
                        control?.sendStatus("idle")
                        control?.sendEnded()
                    }
                    Player.STATE_IDLE -> {}
                }
            }

            override fun onPlayerError(error: PlaybackException) {
                control?.sendStatus("error", error.errorCodeName)
                showStatus(getString(R.string.playback_error, currentTitle))
                // Live streams hiccup; retry the current source after a pause.
                main.removeCallbacks(retryPlayback)
                main.postDelayed(retryPlayback, RETRY_DELAY_MS)
            }
        })
    }

    // ---- ControlClient.Listener -------------------------------------------

    override fun onPlay(url: String, title: String) {
        // Server sends its local streams as a relative path; resolve against
        // the configured server address.
        val base = Prefs.httpBase(this) ?: return
        val absolute = if (url.startsWith("/")) base + url else url
        currentUrl = absolute
        currentTitle = title
        startPlayback(absolute, title)
    }

    override fun onStopCommand() {
        currentUrl = null
        main.removeCallbacks(retryPlayback)
        player?.stop()
        player?.clearMediaItems()
        control?.sendStatus("idle")
        showStatus(getString(R.string.waiting_for_content, Prefs.deviceName()))
    }

    override fun onConnectionChanged(connected: Boolean) {
        if (!connected) {
            showStatus(getString(R.string.reconnecting, Prefs.server(this) ?: ""))
        } else if (currentUrl == null) {
            showStatus(getString(R.string.waiting_for_content, Prefs.deviceName()))
        }
    }

    // ---- playback -----------------------------------------------------------

    private fun startPlayback(url: String, title: String) {
        val exo = player ?: return
        showStatus(getString(R.string.loading, title))
        exo.setMediaItem(MediaItem.fromUri(url))
        exo.prepare()
        exo.play()
    }

    private fun showStatus(text: String) {
        statusText.text = text
        statusText.visibility = View.VISIBLE
    }

    private fun hideStatus() {
        statusText.visibility = View.GONE
    }

    @Suppress("DEPRECATION")
    private fun enterImmersiveMode() {
        window.decorView.systemUiVisibility =
            View.SYSTEM_UI_FLAG_FULLSCREEN or
            View.SYSTEM_UI_FLAG_HIDE_NAVIGATION or
            View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
    }

    companion object {
        private const val RETRY_DELAY_MS = 5_000L
    }
}
