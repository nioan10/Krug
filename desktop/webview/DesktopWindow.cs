#if KRUG_PRODUCTION
using System.Drawing;
using System.Diagnostics;
using System.Net;
using System.Reflection;
using System.Web.Script.Serialization;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

namespace Krug.Webview;

internal sealed class DesktopWindow : Form
{
#if KRUG_TEST
    private const string Origin = "http://127.0.0.1:9350";
#else
    private const string Origin = "https://chat.nioservices.website";
#endif
    private readonly WebView2 browser = new() { Dock = DockStyle.Fill };
    private readonly JavaScriptSerializer json = new() { MaxJsonLength = 128 * 1024, RecursionLimit = 8 };
    private readonly UpdateGate updates;
    private AudioCapture? audio;
    private bool choosing;
    private int navigationGeneration;
    private int audioGeneration;
#if KRUG_TEST
    private bool testCookieIsolation;
#endif
    private string updateState = "idle";
    private int updatePercent = 0;
    private readonly CancellationTokenSource closing = new();
    private readonly System.Windows.Forms.Timer updateTimer = new() { Interval = 10 * 60 * 1000 };
    private UpdateDownloader.Downloaded? downloadedUpdate;
#if !KRUG_TEST
    private bool checkingUpdate;
#endif

    private static bool IsOrigin(string? address) => Uri.TryCreate(address, UriKind.Absolute, out var uri) &&
        string.Equals(uri.GetLeftPart(UriPartial.Authority), Origin, StringComparison.OrdinalIgnoreCase);

    public DesktopWindow()
    {
#if KRUG_RELEASE
        Text = "Округ";
#else
        Text = "Округ — экспериментальная версия";
#endif
        Width = 1280; Height = 820; MinimumSize = new Size(600, 500);
#if KRUG_TEST
        ShowInTaskbar = false; Opacity = 0;
#endif
        BackColor = Color.FromArgb(20, 25, 21);
        Controls.Add(browser);
        updates = new UpdateGate(Schedule, InstallUpdate, ReportUpdate);
        Shown += InitializeAsync;
        Activated += (_, _) => _ = CheckForUpdatesAsync();
        updateTimer.Tick += (_, _) => _ = CheckForUpdatesAsync();
        FormClosed += (_, _) => { navigationGeneration++; audioGeneration++; closing.Cancel(); updateTimer.Dispose(); audio?.Dispose(); };
    }

    protected override void OnHandleCreated(EventArgs e)
    {
        base.OnHandleCreated(e);
        WindowTheme.Apply(Handle);
    }

    private async void InitializeAsync(object? sender, EventArgs args)
    {
        try
        {
#if KRUG_TEST
            var profile = Path.Combine(Path.GetTempPath(), "krug-desktop-isolated-test");
#else
            var profile = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Krug", "WebView2");
#endif
#if KRUG_TEST
            var environment = await CoreWebView2Environment.CreateAsync(null, profile, new CoreWebView2EnvironmentOptions("--autoplay-policy=no-user-gesture-required"));
#else
            var environment = await CoreWebView2Environment.CreateAsync(null, profile);
#endif
            await browser.EnsureCoreWebView2Async(environment);
            var core = browser.CoreWebView2;
            core.Settings.AreHostObjectsAllowed = false;
            core.Settings.IsWebMessageEnabled = true;
            core.Settings.AreDefaultContextMenusEnabled = false;
            core.Settings.AreDevToolsEnabled = false;
#if KRUG_TEST
            var systemCookie = new Cookie("__Host-krug", "synthetic", "/", "example.invalid")
                { Secure = true, HttpOnly = true, Expires = DateTime.UtcNow.AddMinutes(5) };
            var testCookie = core.CookieManager.CreateCookieWithSystemNetCookie(systemCookie);
            testCookie.SameSite = CoreWebView2CookieSameSiteKind.Strict;
            core.CookieManager.AddOrUpdateCookie(testCookie);
            var domainCookies = await core.CookieManager.GetCookiesAsync("https://example.invalid/");
            var subdomainCookies = await core.CookieManager.GetCookiesAsync("https://sub.example.invalid/");
            testCookieIsolation = domainCookies.Any(cookie => cookie.Name == "__Host-krug" && cookie.IsSecure && cookie.IsHttpOnly) &&
                !subdomainCookies.Any(cookie => cookie.Name == "__Host-krug");
            core.CookieManager.DeleteCookie(testCookie);
#endif
            core.NavigationStarting += (_, navigation) =>
            {
                if (!IsOrigin(navigation.Uri)) { navigation.Cancel = true; return; }
                navigationGeneration++;
                audioGeneration++;
                audio?.Stop();
                updates.ResetCallState();
            };
            core.NewWindowRequested += (_, request) => request.Handled = true;
            core.NavigationCompleted += (_, navigation) => { if (navigation.IsSuccess) _ = CheckForUpdatesAsync(); };
            core.PermissionRequested += (_, request) =>
            {
#if KRUG_TEST
                request.State = CoreWebView2PermissionState.Deny;
#else
                if (!IsOrigin(request.Uri)) request.State = CoreWebView2PermissionState.Deny;
                // The default WebView2 dialog obtains explicit camera/mic consent.
                else if (request.PermissionKind is not (CoreWebView2PermissionKind.Microphone or CoreWebView2PermissionKind.Camera))
                    request.State = CoreWebView2PermissionState.Deny;
                request.SavesInProfile = false;
#endif
            };
            core.ScreenCaptureStarting += (_, request) =>
            {
#if KRUG_TEST
                request.Cancel = true;
#else
                if (!IsOrigin(request.OriginalSourceFrameInfo.Source) || request.OriginalSourceFrameInfo.ParentFrameInfo != null)
                    request.Cancel = true;
#endif
            };
#if KRUG_TEST
            var fixture = Environment.GetEnvironmentVariable("KRUG_WEBVIEW_TEST_HTML") ?? throw new InvalidOperationException("Test fixture missing.");
            core.AddWebResourceRequestedFilter(Origin + "/*", CoreWebView2WebResourceContext.All);
            core.WebResourceRequested += (_, request) =>
            {
                var script = Environment.GetEnvironmentVariable("KRUG_WEBVIEW_TEST_SCRIPT");
                var isHtml = request.Request.Uri == Origin + "/";
                var source = isHtml ? fixture : request.Request.Uri == Origin + "/fixture.js" ? script : null;
                if (!string.IsNullOrEmpty(source)) request.Response = environment.CreateWebResourceResponse(
                    new MemoryStream(File.ReadAllBytes(source)), 200, "OK", $"Content-Type: {(isHtml ? "text/html" : "text/javascript")}; charset=utf-8\r\nCache-Control: no-store");
            };
            var audioHelper = Environment.GetEnvironmentVariable("KRUG_WEBVIEW_TEST_FAKE_AUDIO_HELPER") ?? throw new InvalidOperationException("Test helper missing.");
#else
            var audioHelper = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "capture", "Krug.Capture.exe");
#endif
            audio = new AudioCapture(audioHelper,
                bytes => Send(new { type = "audio", data = Convert.ToBase64String(bytes) }),
                () => Send(new { type = "audio-ended" }));
            core.WebMessageReceived += OnMessage;
            using var stream = Assembly.GetExecutingAssembly().GetManifestResourceStream("Krug.Desktop.bridge.js")
                ?? throw new InvalidOperationException("Desktop bridge is missing.");
            using var reader = new StreamReader(stream);
            await core.AddScriptToExecuteOnDocumentCreatedAsync(
                $"if (window.top === window && location.origin === {json.Serialize(Origin)}) {{ {reader.ReadToEnd()} }}");
#if !KRUG_TEST
            await MigrationRestore.TryRestoreAsync(core.CookieManager, new Uri(Origin + "/"));
#endif
            core.Navigate(Origin);
            updateTimer.Start();
        }
        catch (Exception)
        {
#if KRUG_TEST
            Console.Error.WriteLine("Isolated desktop host initialization failed.");
#else
            MessageBox.Show(this, "Не удалось открыть приложение. Проверьте наличие Microsoft Edge WebView2 Runtime.", "Округ", MessageBoxButtons.OK, MessageBoxIcon.Error);
#endif
            Close();
        }
    }

    private async void OnMessage(object? sender, CoreWebView2WebMessageReceivedEventArgs args)
    {
        if (!IsOrigin(args.Source) || !IsOrigin(browser.CoreWebView2.Source)) return;
        var generation = navigationGeneration;
        int id;
        Dictionary<string, object>? message;
        try
        {
            if (args.WebMessageAsJson.Length > 4096) return;
            message = json.Deserialize<Dictionary<string, object>>(args.WebMessageAsJson);
#if KRUG_TEST
            if (message != null && message.TryGetValue("type", out var testType) && testType is string testTypeString && testTypeString == "test-result")
            {
                var testResult = Environment.GetEnvironmentVariable("KRUG_WEBVIEW_TEST_RESULT") ?? throw new InvalidOperationException("Test output missing.");
                File.WriteAllText(testResult, args.WebMessageAsJson);
                BeginInvoke(new Action(Close));
                return;
            }
#endif
            if (message is null || !message.TryGetValue("id", out var rawId) || rawId is not int requestId || requestId <= 0 ||
                !message.TryGetValue("method", out var rawMethod) || rawMethod is not string) return;
            id = requestId;
        }
        catch (ArgumentException) { return; }
        catch (InvalidOperationException) { return; }
        object? result = null;
        string? error = null;
        try
        {
            switch ((string)message["method"])
            {
                case "audio-start":
                    if (audio is null || choosing) throw new InvalidOperationException();
                    var requestGeneration = audioGeneration;
                    choosing = true;
                    try
                    {
#if KRUG_TEST
                        var window = Environment.GetEnvironmentVariable("KRUG_WEBVIEW_TEST_SYNTHETIC_WINDOW") == "4" ? 4L : 1L;
#else
                        using var picker = new WindowPicker(Handle);
                        if (picker.ShowDialog(this) != DialogResult.OK || picker.SelectedWindow is not long window) { result = false; break; }
#endif
                        if (generation != navigationGeneration || requestGeneration != audioGeneration || !IsOrigin(browser.CoreWebView2.Source)) throw new OperationCanceledException();
                        await audio.StartAsync(window);
                        if (generation != navigationGeneration || requestGeneration != audioGeneration) { audio.Stop(); throw new OperationCanceledException(); }
                        result = true;
                    }
                    finally { choosing = false; }
                    break;
                case "audio-stop": audioGeneration++; audio?.Stop(); break;
                case "call-state" when message.TryGetValue("value", out var value) && value is bool active:
                    updates.SetCallActive(active); break;
                case "update-state":
#if KRUG_TEST
                    result = new { state = updateState, percent = updatePercent, testCookieIsolation };
#else
                    result = new { state = updateState, percent = updatePercent };
#endif
                    break;
                default: throw new InvalidOperationException();
            }
        }
        catch (Exception) { error = "Не удалось выполнить действие в приложении."; }
        if (generation == navigationGeneration) Send(new { type = "result", id, value = result, error });
    }

    private void Send(object value)
    {
        if (!IsDisposed && browser.CoreWebView2 != null && IsOrigin(browser.CoreWebView2.Source))
            browser.CoreWebView2.PostWebMessageAsJson(json.Serialize(value));
    }

    private static void Schedule(Action callback)
    {
        var timer = new System.Windows.Forms.Timer { Interval = 1000 };
        timer.Tick += (_, _) => { timer.Stop(); timer.Dispose(); callback(); };
        timer.Start();
    }

    private void ReportUpdate(string state) { updateState = state; Send(new { type = "update", status = new { state } }); }

    private async Task CheckForUpdatesAsync()
    {
#if KRUG_TEST
        await Task.CompletedTask;
        return;
#else
        if (checkingUpdate || downloadedUpdate != null || IsDisposed || browser.CoreWebView2 is null || !IsOrigin(browser.CoreWebView2.Source)) return;
        checkingUpdate = true;
        try
        {
            var origin = new Uri(Origin + "/");
            var webCookies = await browser.CoreWebView2.CookieManager.GetCookiesAsync(origin.AbsoluteUri);
            var session = webCookies.FirstOrDefault(cookie => cookie.Name == "__Host-krug" && cookie.IsHttpOnly && cookie.IsSecure &&
                cookie.Path == "/" && cookie.Domain.TrimStart('.').Equals(origin.Host, StringComparison.OrdinalIgnoreCase));
            if (session is null) return;
            var cookies = new CookieContainer();
            cookies.Add(origin, session.ToSystemNetCookie());
            using var accessClient = UpdateAccess.CreateClient(cookies);
            var token = await UpdateAccess.GetTokenAsync(accessClient, origin, closing.Token);
            using var downloadClient = UpdateDownloader.CreateClient();
            var directory = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Krug", "updates");
            var current = Assembly.GetExecutingAssembly().GetName().Version ?? new Version(0, 0, 0);
            var progress = new Progress<int>(percent =>
            {
                if (IsDisposed || downloadedUpdate != null) return;
                updateState = "downloading"; updatePercent = percent;
                Send(new { type = "update", status = new { state = updateState, percent } });
            });
            var candidate = await new UpdateDownloader(downloadClient, origin, directory).DownloadAsync(token, current, closing.Token, progress);
            if (candidate is null) { ReportUpdate("idle"); return; }
            downloadedUpdate = candidate;
            updates.Downloaded();
        }
        catch (OperationCanceledException) { }
        catch (Exception) { if (!IsDisposed) ReportUpdate("error"); }
        finally { checkingUpdate = false; }
#endif
    }

    private void InstallUpdate()
    {
        var candidate = downloadedUpdate;
        if (candidate is null) return;
        try
        {
            using (var file = new FileStream(candidate.Path, FileMode.Open, FileAccess.Read, FileShare.Read))
                if (!candidate.Manifest.Verify(file)) throw new InvalidDataException("Installer changed after download.");
            var start = new ProcessStartInfo(candidate.Path, "--updated /S --force-run") { UseShellExecute = false, CreateNoWindow = true };
            if (Process.Start(start) is null) throw new InvalidOperationException("Unable to start installer.");
            Close();
        }
        catch (Exception)
        {
            downloadedUpdate = null;
            try { File.Delete(candidate.Path); } catch (IOException) { } catch (UnauthorizedAccessException) { }
            ReportUpdate("error");
        }
    }
}
#endif
