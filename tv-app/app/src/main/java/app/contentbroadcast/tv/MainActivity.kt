package app.contentbroadcast.tv

import android.content.Intent
import android.os.Bundle
import androidx.appcompat.app.AppCompatActivity

/** Entry point: route to setup on first run, otherwise straight to the player. */
class MainActivity : AppCompatActivity() {

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val next = if (Prefs.server(this) == null) {
            SetupActivity::class.java
        } else {
            PlayerActivity::class.java
        }
        startActivity(Intent(this, next))
        finish()
    }
}
