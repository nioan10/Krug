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
    private boolean active = true, resumed, checking, downloading, stopped, requested, settingsRequested;
    private volatile String state = "idle";
    private JSONObject candidate;
    private File ready;
    private final java.util.function.Consumer<String> report;
    private final Runnable periodic = new Runnable() { @Override public void run() { if (!stopped) { check(); main.postDelayed(this, 120_000); } } };

    AndroidUpdater(Activity activity, java.util.function.Consumer<String> report) { this.activity = activity; this.report = report; main.post(periodic); }
    String getState() { return state; }
    private void publish(String value) { state = value; report.accept(value); }
    void setCallActive(boolean value) { active = value; if (!value && requested) { if (ready != null) install(); else download(); } else if (!value) check(); }
    void onResume() {
        resumed = true;
        if (settingsRequested) { settingsRequested = false; if (!activity.getPackageManager().canRequestPackageInstalls()) { requested = false; publish("available"); return; } }
        if (requested && !active) { if (ready != null) install(); else download(); } else check();
    }
    void onPause() { resumed = false; }
    void stop() { stopped = true; main.removeCallbacksAndMessages(null); worker.shutdownNow(); }
    void cancel() { requested = false; if (candidate != null) publish("available"); }
    void requestUpdate() {
        if (candidate == null) { check(); return; }
        requested = true;
        if (active || !resumed) { publish("queued"); return; }
        if (ready != null) install(); else download();
    }
    private HttpURLConnection connection(String path, String cookie) throws Exception {
        HttpURLConnection conn = (HttpURLConnection) new URL(ROOT + path).openConnection();
        conn.setConnectTimeout(12_000); conn.setReadTimeout(20_000); conn.setInstanceFollowRedirects(false);
        conn.setRequestProperty("Cookie", cookie); conn.setRequestProperty("X-Krug-Android-Update-Mode", "manual-v1");
        conn.setRequestProperty("Accept", "application/json, application/vnd.android.package-archive");
        if (conn.getResponseCode() != 200) { conn.disconnect(); throw new Exception("Unavailable"); }
        return conn;
    }
    void check() {
        if (stopped || checking || downloading || candidate != null) return;
        String cookie = CookieManager.getInstance().getCookie(ROOT);
        if (cookie == null || cookie.isEmpty()) return;
        checking = true;
        worker.execute(() -> {
            JSONObject available = null;
            try {
                HttpURLConnection meta = connection("/api/android-updates/latest.json", cookie);
                ByteArrayOutputStream bytes = new ByteArrayOutputStream();
                try (InputStream input = meta.getInputStream()) { byte[] b = new byte[2048]; int n; while ((n = input.read(b)) != -1) { bytes.write(b, 0, n); if (bytes.size() > 8192) throw new Exception("Manifest too large"); } } finally { meta.disconnect(); }
                JSONObject json = new JSONObject(bytes.toString("UTF-8"));
                int version = json.getInt("versionCode"); String file = json.getString("file"), sha = json.getString("sha256"); long size = json.getLong("size");
                if (version <= activity.getPackageManager().getPackageInfo(activity.getPackageName(), 0).versionCode || size <= 0 || size > MAX_SIZE || !file.matches("Okrug-[0-9]+\\.[0-9]+\\.[0-9]+\\.apk") || !sha.matches("[a-f0-9]{64}")) throw new Exception("No update");
                available = json;
            } catch (Exception ignored) { /* Offline checks retry later. */ }
            final JSONObject result = available;
            main.post(() -> { checking = false; if (!stopped && result != null) { candidate = result; publish("available"); } });
        });
    }
    private void download() {
        if (stopped || downloading || !requested || active || candidate == null) return;
        String cookie = CookieManager.getInstance().getCookie(ROOT);
        if (cookie == null || cookie.isEmpty()) { requested = false; publish("error"); return; }
        final JSONObject manifest = candidate; downloading = true; publish("downloading");
        worker.execute(() -> {
            File downloaded = null;
            try {
                int version = manifest.getInt("versionCode"); String file = manifest.getString("file"), sha = manifest.getString("sha256"); long size = manifest.getLong("size");
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
            } catch (Exception ignored) { /* The user can retry from the banner. */ }
            final File result = downloaded;
            main.post(() -> { downloading = false; if (stopped) return; if (result == null) { requested = false; publish("error"); return; } ready = result; if (!requested) publish("available"); else if (active || !resumed) publish("queued"); else install(); });
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
    private void install() {
        if (stopped || !requested || ready == null) return;
        if (active || !resumed) { publish("queued"); return; }
        if (!activity.getPackageManager().canRequestPackageInstalls()) {
            try { settingsRequested = true; activity.startActivity(new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:" + activity.getPackageName()))); }
            catch (Exception ignored) { settingsRequested = false; requested = false; publish("error"); }
            return;
        }
        try {
            Uri uri = Uri.parse("content://website.nioservices.krug.updates/update.apk");
            Intent intent = new Intent(Intent.ACTION_VIEW).setDataAndType(uri, "application/vnd.android.package-archive").addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
            requested = false; publish("available"); activity.startActivity(intent);
        } catch (Exception ignored) { requested = false; publish("error"); }
    }
}
