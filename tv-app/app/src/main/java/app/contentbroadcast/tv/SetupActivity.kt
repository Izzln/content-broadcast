package app.contentbroadcast.tv

import android.content.Intent
import android.os.Bundle
import android.widget.Button
import android.widget.EditText
import android.widget.TextView
import android.widget.Toast
import androidx.appcompat.app.AppCompatActivity

/** One-time pairing: enter the server's LAN address (host:port). */
class SetupActivity : AppCompatActivity() {

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_setup)

        val addressInput = findViewById<EditText>(R.id.server_address)
        val deviceIdText = findViewById<TextView>(R.id.device_id)
        val saveButton = findViewById<Button>(R.id.save_button)

        Prefs.server(this)?.let { addressInput.setText(it) }
        deviceIdText.text = getString(R.string.device_id_label, Prefs.deviceId(this))

        saveButton.setOnClickListener {
            val address = addressInput.text.toString().trim()
                .removePrefix("http://").removeSuffix("/")
            if (!address.matches(Regex("""[\w.-]+(:\d+)?"""))) {
                Toast.makeText(this, R.string.invalid_address, Toast.LENGTH_SHORT).show()
                return@setOnClickListener
            }
            val hostPort = if (address.contains(':')) address else "$address:8080"
            Prefs.setServer(this, hostPort)
            startActivity(Intent(this, PlayerActivity::class.java))
            finish()
        }
    }
}
