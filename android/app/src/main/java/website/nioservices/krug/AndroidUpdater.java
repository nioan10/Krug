package website.nioservices.krug;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.Intent;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.content.pm.Signature;
import android.net.Uri;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.provider.Settings;
import android.webkit.CookieManager;
import org.json.JSONObject;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.security.MessageDigest;
import java.util.Arrays;
import java.util.concurrent.Executors;
import java.util.concurrent.ExecutorService;

/** Downloads only authenticated, same-origin updates and waits until calls finish. */
final class AndroidUpdater {
    private static final String ROOT = "https://chat.nioservices.website";
    private static final long MAX_SIZE = 50L * 1024 * 1024;
    private final Activity activity;
    private final Handler main = new Handler(Looper.getMainLooper());
    private final ExecutorService worker = Executors.newSingleThreadExecutor();
    private boolean active = true, resumed, checking, stopped, consented, offering;
    private int offeredVersion;
    private File ready;
    private final Runnable periodic = new Runnable() { @Override public void run() { if (!stopped) { check(); main.postDelayed(this, 120_000); } } };

    AndroidUpdater(Activity activity) { this.activity = activity; main.post(periodic); }
    void setCallActive(boolean value) { active = value; if (!value) { if (consented) install(); else if (ready != null) offer(); else check(); } }
    void onResume() { resumed = true; if (consented && ready != null && !active) install(); else if (!active && ready != null) offer(); else check(); }
    void onPause() { resumed = false; }
    void stop() { stopped = true; main.removeCallbacksAndMessages(null); worker.shutdownNow(); }
    private HttpURLConnection connection(String path, String cookie) throws Exception {
        HttpURLConnection conn = (HttpURLConnection) new URL(ROOT + path).openConnection();
        conn.setConnectTimeout(12_000); conn.setReadTimeout(20_000); conn.setInstanceFollowRedirects(false);
        conn.setRequestProperty("Cookie", cookie); conn.setRequestProperty("Accept", "application/json, application/vnd.android.package-archive");
        if (conn.getResponseCode() != 200) { conn.disconnect(); throw new Exception("Unavailable"); }
        return conn;
    }
    void check() {
        if (stopped || checking || active || ready != null) return;
        String cookie = CookieManager.getInstance().getCookie(ROOT);
        if (cookie == null || cookie.isEmpty()) return;
        checking = true;
        worker.execute(() -> {
            File downloaded = null; int version = 0;
            try {
                HttpURLConnection meta = connection("/api/android-updates/latest.json", cookie);
                ByteArrayOutputStream bytes = new ByteArrayOutputStream();
                try (InputStream input = meta.getInputStream()) { byte[] b = new byte[2048]; int n; while ((n = input.read(b)) != -1) { bytes.write(b, 0, n); if (bytes.size() > 8192) throw new Exception("Manifest too large"); } } finally { meta.disconnect(); }
                JSONObject json = new JSONObject(bytes.toString("UTF-8"));
                version = json.getInt("versionCode"); String file = json.getString("file"), sha = json.getString("sha256"); long size = json.getLong("size");
                if (version <= activity.getPackageManager().getPackageInfo(activity.getPackageName(), 0).versionCode || version == offeredVersion || size <= 0 || size > MAX_SIZE || !file.matches("Okrug-[0-9]+\\.[0-9]+\\.[0-9]+\\.apk") || !sha.matches("[a-f0-9]{64}")) throw new Exception("No update");
                File dir = new File(activity.getCacheDir(), "updates"); if (!dir.isDirectory() && !dir.mkdirs()) throw new Exception("Storage unavailable");
                File temp = new File(dir, "download.apk"); File target = new File(dir, "update.apk");
                MessageDigest digest = MessageDigest.getInstance("SHA-256"); long total = 0;
                HttpURLConnection apk = connection("/api/android-updates/" + file, cookie);
                try (InputStream input = apk.getInputStream(); FileOutputStream out = new FileOutputStream(temp)) {
                    byte[] buffer = new byte[32768]; int n;
                    while ((n = input.read(buffer)) != -1) { total += n; if (total > size || total > MAX_SIZE) throw new Exception("Package too large"); digest.update(buffer, 0, n); out.write(buffer, 0, n); }
                } finally { apk.disconnect(); }
                StringBuilder actual = new StringBuilder(); for (byte b : digest.digest()) actual.append(String.format(java.util.Locale.ROOT, "%02x", b & 0xff));
                if (total != size || !actual.toString().equals(sha) || !matchesInstalled(temp, version)) throw new Exception("Invalid package");
                if (target.exists() && !target.delete()) throw new Exception("Storage unavailable");
                if (!temp.renameTo(target)) throw new Exception("Storage unavailable");
                downloaded = target;
            } catch (Exception ignored) { /* Retry after network recovery or the next check. */ }
            final File result = downloaded; final int nextVersion = version;
            main.post(() -> { checking = false; if (stopped) return; if (result != null) { ready = result; offeredVersion = nextVersion; if (!active && resumed) offer(); } });
        });
    }
    private boolean matchesInstalled(File apk, int version) throws Exception {
        PackageManager pm = activity.getPackageManager();
        int flags = Build.VERSION.SDK_INT >= 28 ? PackageManager.GET_SIGNING_CERTIFICATES : PackageManager.GET_SIGNATURES;
        PackageInfo candidate = pm.getPackageArchiveInfo(apk.getAbsolutePath(), flags);
        PackageInfo installed = pm.getPackageInfo(activity.getPackageName(), flags);
        if (candidate == null || !activity.getPackageName().equals(candidate.packageName) || candidate.versionCode != version) return false;
        Signature[] a = Build.VERSION.SDK_INT >= 28 && candidate.signingInfo != null ? candidate.signingInfo.getApkContentsSigners() : candidate.signatures;
        Signature[] b = Build.VERSION.SDK_INT >= 28 && installed.signingInfo != null ? installed.signingInfo.getApkContentsSigners() : installed.signatures;
        return a != null && b != null && a.length == 1 && b.length == 1 && Arrays.equals(a[0].toByteArray(), b[0].toByteArray());
    }
    private void offer() {
        if (stopped || active || !resumed || ready == null || offering || activity.isFinishing()) return;
        offering = true;
        new AlertDialog.Builder(activity).setTitle("Обновление Округа").setMessage("Новая версия приложения загружена. Установить сейчас?")
            .setNegativeButton("Позже", (dialog, which) -> { ready = null; })
            .setPositiveButton("Обновить", (dialog, which) -> { consented = true; install(); })
            .setOnDismissListener(dialog -> offering = false).show();
    }
    private void install() {
        if (stopped || active || !resumed || ready == null || !consented) return;
        if (!activity.getPackageManager().canRequestPackageInstalls()) {
            try { activity.startActivity(new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:" + activity.getPackageName()))); }
            catch (Exception ignored) { consented = false; }
            return;
        }
        try {
            Uri uri = Uri.parse("content://website.nioservices.krug.updates/update.apk");
            Intent intent = new Intent(Intent.ACTION_VIEW).setDataAndType(uri, "application/vnd.android.package-archive").addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
            consented = false; ready = null; activity.startActivity(intent);
        } catch (Exception ignored) { consented = false; }
    }
}
