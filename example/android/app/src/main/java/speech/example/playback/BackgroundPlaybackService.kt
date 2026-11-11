package speech.example.playback

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import speech.example.MainActivity

/**
 * Foreground service of type mediaPlayback. While it runs, Android keeps the
 * app's process in the foreground scheduling group with the screen off, so
 * neural synthesis keeps the cores it has with the screen on. Without it the
 * process moves to the background cpuset (little cores only on many phones)
 * and synthesis can fall behind playback. See docs/USAGE.md, "Background
 * playback on Android".
 */
class BackgroundPlaybackService : Service() {
  override fun onBind(intent: Intent?): IBinder? = null

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    val manager = getSystemService(NotificationManager::class.java)
    manager.createNotificationChannel(
      NotificationChannel(CHANNEL_ID, "Speech playback", NotificationManager.IMPORTANCE_LOW),
    )
    val openApp = PendingIntent.getActivity(
      this,
      0,
      Intent(this, MainActivity::class.java),
      PendingIntent.FLAG_IMMUTABLE,
    )
    val notification = Notification.Builder(this, CHANNEL_ID)
      .setContentTitle("Speech playback")
      .setContentText("Speaking with the screen off")
      .setSmallIcon(android.R.drawable.ic_media_play)
      .setContentIntent(openApp)
      .setOngoing(true)
      .build()
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
      startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK)
    } else {
      startForeground(NOTIFICATION_ID, notification)
    }
    return START_NOT_STICKY
  }

  companion object {
    private const val CHANNEL_ID = "speech-playback"
    private const val NOTIFICATION_ID = 1
  }
}
