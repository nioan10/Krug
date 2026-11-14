package website.nioservices.krug;

import android.Manifest;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.IBinder;

/** Keeps an active voice session visible to the user while the app is backgrounded. */
public final class CallService extends Service {
    @Override public int onStartCommand(Intent intent, int flags, int startId) {
        NotificationManager manager = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
        manager.createNotificationChannel(new NotificationChannel("voice", "Голосовая комната", NotificationManager.IMPORTANCE_LOW));
        Intent back = new Intent(this, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        PendingIntent launch = PendingIntent.getActivity(this, 0, back, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        Notification notice = new Notification.Builder(this, "voice").setSmallIcon(android.R.drawable.ic_btn_speak_now)
            .setContentTitle("Округ · голосовая комната").setContentText("Нажмите, чтобы вернуться в комнату")
            .setContentIntent(launch).setOngoing(true).setCategory(Notification.CATEGORY_CALL).build();
        try {
            if (Build.VERSION.SDK_INT >= 29) {
                int type = ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK;
                if (Build.VERSION.SDK_INT >= 30 && intent != null && intent.getBooleanExtra("microphone", false) && checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED) type |= ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE;
                startForeground(25, notice, type);
            } else startForeground(25, notice);
        } catch (RuntimeException error) { stopSelf(); }
        return START_NOT_STICKY;
    }
    @Override public IBinder onBind(Intent intent) { return null; }
}
