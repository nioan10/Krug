package website.nioservices.krug;

import android.Manifest;
import android.app.Activity;
import android.app.AlertDialog;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Message;
import android.provider.Settings;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.CookieManager;
import android.webkit.JsResult;
import android.webkit.PermissionRequest;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.ProgressBar;
import android.widget.TextView;
import java.util.ArrayList;
import java.util.List;

public final class MainActivity extends Activity {
    private static final String HOME = "https://chat.nioservices.website/";
    private static final int FILE_REQUEST = 20;
    private static final int MEDIA_REQUEST = 21;
    private WebView web;
    private FrameLayout root;
    private View offline;
    private ProgressBar progress;
    private PermissionRequest mediaRequest;
    private ValueCallback<Uri[]> fileCallback;
    private View fullScreenView;
    private WebChromeClient.CustomViewCallback fullScreenCallback;
    private AndroidUpdater updater;
    private boolean callActive, microphoneActive;

    private static boolean trusted(Uri uri) {
        return uri != null && "https".equalsIgnoreCase(uri.getScheme()) &&
            "chat.nioservices.website".equalsIgnoreCase(uri.getHost()) &&
            uri.getUserInfo() == null && (uri.getPort() == -1 || uri.getPort() == 443);
    }

    @Override public void onCreate(Bundle saved) {
        super.onCreate(saved);
        getWindow().setStatusBarColor(Color.rgb(17, 23, 19));
        getWindow().setNavigationBarColor(Color.rgb(17, 23, 19));
        getWindow().setSoftInputMode(android.view.WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE);
        root = new FrameLayout(this);
        root.setBackgroundColor(Color.rgb(17, 23, 19));
        root.setFitsSystemWindows(true);
        web = new WebView(this);
        web.setBackgroundColor(Color.rgb(17, 23, 19));
        WebSettings settings = web.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setMediaPlaybackRequiresUserGesture(false);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(true);
        settings.setJavaScriptCanOpenWindowsAutomatically(false);
        settings.setSupportMultipleWindows(true);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        settings.setUserAgentString(settings.getUserAgentString() + " KrugAndroid/1");
        updater = new AndroidUpdater(this);
        web.addJavascriptInterface(new NativeBridge(), "KrugAndroidNative");
        CookieManager.getInstance().setAcceptCookie(true);
        CookieManager.getInstance().setAcceptThirdPartyCookies(web, false);
        web.setWebViewClient(new Client());
        web.setWebChromeClient(new Chrome());
        root.addView(web, new FrameLayout.LayoutParams(-1, -1));
        progress = new ProgressBar(this, null, android.R.attr.progressBarStyleHorizontal);
        progress.setMax(100);
        progress.setProgressTintList(android.content.res.ColorStateList.valueOf(Color.rgb(182, 230, 141)));
        root.addView(progress, new FrameLayout.LayoutParams(-1, dp(3), Gravity.TOP));
        setContentView(root);
        Uri initial = getIntent().getData();
        web.loadUrl(trusted(initial) ? initial.toString() : HOME);
    }

    private int dp(int value) { return (int) (value * getResources().getDisplayMetrics().density + .5f); }
    public final class NativeBridge {
        @android.webkit.JavascriptInterface public void setCallActive(boolean active) { runOnUiThread(() -> { if (!isFinishing() && !isDestroyed()) { boolean joining = active && !callActive; callActive = active; updater.setCallActive(active); updateCallService(); if (joining) requestCallNotifications(); } }); }
        @android.webkit.JavascriptInterface public void setMicrophoneActive(boolean active) { runOnUiThread(() -> { if (!isFinishing() && !isDestroyed()) { microphoneActive = active; updateCallService(); } }); }
    }
    private void updateCallService() {
        Intent intent = new Intent(this, CallService.class).putExtra("microphone", microphoneActive);
        if (!callActive) { stopService(intent); return; }
        try { startForegroundService(intent); } catch (RuntimeException ignored) { /* A background start can be denied by Android. */ }
    }
    private void requestCallNotifications() {
        if (Build.VERSION.SDK_INT < 33 || checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED || getPreferences(MODE_PRIVATE).getBoolean("askedCallNotification", false)) return;
        getPreferences(MODE_PRIVATE).edit().putBoolean("askedCallNotification", true).apply();
        requestPermissions(new String[] { Manifest.permission.POST_NOTIFICATIONS }, 22);
    }

    private void openExternal(Uri uri) {
        if (uri == null || !("https".equalsIgnoreCase(uri.getScheme()) || "http".equalsIgnoreCase(uri.getScheme()))) return;
        try { startActivity(new Intent(Intent.ACTION_VIEW, uri).addCategory(Intent.CATEGORY_BROWSABLE)); }
        catch (Exception ignored) { new AlertDialog.Builder(this).setMessage("Не удалось открыть ссылку.").setPositiveButton("Понятно", null).show(); }
    }

    private void showOffline() {
        if (offline != null) return;
        LinearLayout layout = new LinearLayout(this);
        layout.setGravity(Gravity.CENTER); layout.setOrientation(LinearLayout.VERTICAL);
        layout.setPadding(dp(32), dp(32), dp(32), dp(32)); layout.setBackgroundColor(Color.rgb(17, 23, 19));
        TextView title = new TextView(this); title.setText("Округ"); title.setTextColor(Color.rgb(190, 238, 154)); title.setTextSize(30); title.setGravity(Gravity.CENTER);
        TextView subtitle = new TextView(this); subtitle.setText("Не удалось подключиться. Проверьте интернет и попробуйте снова."); subtitle.setTextColor(Color.rgb(168, 185, 160)); subtitle.setTextSize(15); subtitle.setGravity(Gravity.CENTER); subtitle.setPadding(0, dp(16), 0, dp(20));
        Button retry = new Button(this); retry.setText("Повторить"); retry.setTextColor(Color.rgb(25, 39, 21)); retry.setAllCaps(false);
        android.graphics.drawable.GradientDrawable button = new android.graphics.drawable.GradientDrawable(); button.setColor(Color.rgb(182, 230, 141)); button.setCornerRadius(dp(10)); retry.setBackground(button);
        retry.setOnClickListener(v -> { hideOffline(); web.loadUrl(HOME); });
        layout.addView(title); layout.addView(subtitle); layout.addView(retry); offline = layout;
        root.addView(offline, new FrameLayout.LayoutParams(-1, -1));
    }
    private void hideOffline() { if (offline != null) { root.removeView(offline); offline = null; } }

    private final class Client extends WebViewClient {
        @Override public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
            if (trusted(request.getUrl())) return false;
            if (request.isForMainFrame() && request.hasGesture()) openExternal(request.getUrl());
            return true;
        }
        @Override public void onPageStarted(WebView view, String url, android.graphics.Bitmap favicon) { updater.setCallActive(true); hideOffline(); progress.setVisibility(View.VISIBLE); }
        @Override public void onPageFinished(WebView view, String url) { progress.setVisibility(View.GONE); CookieManager.getInstance().flush(); }
        @Override public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) { if (request.isForMainFrame()) { android.util.Log.w("Okrug", "Main page load failed, code " + error.getErrorCode()); progress.setVisibility(View.GONE); showOffline(); } }
    }

    private void finishMediaPermission() {
        PermissionRequest request = mediaRequest; mediaRequest = null;
        if (request == null) return;
        if (!trusted(request.getOrigin()) || !trusted(Uri.parse(web.getUrl() == null ? "" : web.getUrl()))) { request.deny(); return; }
        List<String> allowed = new ArrayList<>();
        for (String resource : request.getResources()) {
            if (PermissionRequest.RESOURCE_AUDIO_CAPTURE.equals(resource) && checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED) allowed.add(resource);
            if (PermissionRequest.RESOURCE_VIDEO_CAPTURE.equals(resource) && checkSelfPermission(Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED) allowed.add(resource);
        }
        if (allowed.isEmpty()) request.deny(); else request.grant(allowed.toArray(new String[0]));
    }

    private final class Chrome extends WebChromeClient {
        @Override public void onProgressChanged(WebView view, int value) { progress.setProgress(value); }
        @Override public void onPermissionRequest(PermissionRequest request) {
            runOnUiThread(() -> {
                if (mediaRequest != null || !trusted(request.getOrigin()) || !trusted(Uri.parse(web.getUrl() == null ? "" : web.getUrl()))) { request.deny(); return; }
                List<String> permissions = new ArrayList<>();
                for (String resource : request.getResources()) {
                    if (PermissionRequest.RESOURCE_AUDIO_CAPTURE.equals(resource) && checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) permissions.add(Manifest.permission.RECORD_AUDIO);
                    if (PermissionRequest.RESOURCE_VIDEO_CAPTURE.equals(resource) && checkSelfPermission(Manifest.permission.CAMERA) != PackageManager.PERMISSION_GRANTED) permissions.add(Manifest.permission.CAMERA);
                }
                mediaRequest = request;
                if (permissions.isEmpty()) finishMediaPermission(); else requestPermissions(permissions.toArray(new String[0]), MEDIA_REQUEST);
            });
        }
        @Override public void onPermissionRequestCanceled(PermissionRequest request) { if (mediaRequest == request) mediaRequest = null; }
        @Override public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback, FileChooserParams params) {
            if (!trusted(Uri.parse(web.getUrl() == null ? "" : web.getUrl()))) return false;
            if (fileCallback != null) fileCallback.onReceiveValue(null);
            fileCallback = callback;
            Intent picker = new Intent(Intent.ACTION_OPEN_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE).setType("image/*");
            try { startActivityForResult(picker, FILE_REQUEST); return true; }
            catch (Exception error) { fileCallback = null; callback.onReceiveValue(null); return true; }
        }
        @Override public boolean onCreateWindow(WebView view, boolean dialog, boolean userGesture, Message result) {
            if (!userGesture || !trusted(Uri.parse(view.getUrl() == null ? "" : view.getUrl()))) return false;
            WebView popup = new WebView(MainActivity.this);
            popup.setWebViewClient(new WebViewClient() {
                @Override public boolean shouldOverrideUrlLoading(WebView ignored, WebResourceRequest request) { openExternal(request.getUrl()); popup.post(popup::destroy); return true; }
            });
            WebView.WebViewTransport transport = (WebView.WebViewTransport) result.obj; transport.setWebView(popup); result.sendToTarget(); return true;
        }
        @Override public boolean onJsConfirm(WebView view, String url, String message, JsResult result) {
            if (!trusted(Uri.parse(url))) { result.cancel(); return true; }
            new AlertDialog.Builder(MainActivity.this).setMessage(message).setPositiveButton("Да", (dialog, which) -> result.confirm()).setNegativeButton("Отмена", (dialog, which) -> result.cancel()).setOnCancelListener(dialog -> result.cancel()).show(); return true;
        }
        @Override public void onShowCustomView(View view, CustomViewCallback callback) {
            if (fullScreenView != null) { callback.onCustomViewHidden(); return; }
            fullScreenView = view; fullScreenCallback = callback; root.addView(view, new FrameLayout.LayoutParams(-1, -1)); web.setVisibility(View.GONE);
        }
        @Override public void onHideCustomView() {
            if (fullScreenView == null) return;
            root.removeView(fullScreenView); fullScreenView = null; web.setVisibility(View.VISIBLE); fullScreenCallback.onCustomViewHidden(); fullScreenCallback = null;
        }
    }
    @Override public void onRequestPermissionsResult(int code, String[] permissions, int[] results) { super.onRequestPermissionsResult(code, permissions, results); if (code == MEDIA_REQUEST) finishMediaPermission(); }
    @Override protected void onActivityResult(int code, int resultCode, Intent data) {
        super.onActivityResult(code, resultCode, data);
        if (code != FILE_REQUEST || fileCallback == null) return;
        Uri uri = resultCode == RESULT_OK && data != null ? data.getData() : null;
        fileCallback.onReceiveValue(uri != null && "content".equals(uri.getScheme()) ? new Uri[] { uri } : null); fileCallback = null;
    }
    @Override protected void onNewIntent(Intent intent) { super.onNewIntent(intent); if (trusted(intent.getData())) web.loadUrl(intent.getData().toString()); }
    @Override protected void onResume() { super.onResume(); if (updater != null) updater.onResume(); }
    @Override protected void onPause() { if (updater != null) updater.onPause(); super.onPause(); }
    @Override public void onBackPressed() {
        if (fullScreenView != null) { ((Chrome) web.getWebChromeClient()).onHideCustomView(); return; }
        if (offline != null) { hideOffline(); web.loadUrl(HOME); return; }
        if (web.canGoBack()) { web.goBack(); return; }
        super.onBackPressed();
    }
    @Override protected void onDestroy() {
        updater.stop();
        stopService(new Intent(this, CallService.class));
        if (mediaRequest != null) mediaRequest.deny();
        if (fileCallback != null) fileCallback.onReceiveValue(null);
        ((ViewGroup) web.getParent()).removeView(web); web.destroy();
        super.onDestroy();
    }
}
