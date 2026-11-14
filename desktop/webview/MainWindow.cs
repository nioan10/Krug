using System.Drawing;
using System.Reflection;
using System.Web.Script.Serialization;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

namespace Krug.Webview;

// Isolated prototype only: it cannot access the real server or publish media.
internal sealed class MainWindow : Form
{
    private const string TestOrigin = "http://127.0.0.1:9350";
    private readonly WebView2 browser = new() { Dock = DockStyle.Fill };
    private readonly JavaScriptSerializer json = new() { MaxJsonLength = 4096, RecursionLimit = 8 };
    private readonly UpdateGate updateGate;
    private AudioCapture? testAudio;
    private bool callActive;
    private string updateState = "idle";
    private static void Trace(string value)
    {
        var path = Environment.GetEnvironmentVariable("KRUG_WEBVIEW_TEST_TRACE");
        if (!string.IsNullOrEmpty(path)) File.AppendAllText(path, value + Environment.NewLine);
    }

    private static bool IsTestOrigin(string? address) =>
        Uri.TryCreate(address, UriKind.Absolute, out var uri) &&
        string.Equals(uri.GetLeftPart(UriPartial.Authority), TestOrigin, StringComparison.Ordinal);

    public MainWindow()
    {
        updateGate = new UpdateGate(Schedule, () => throw new InvalidOperationException("Updater is not implemented."), ReportUpdate);
        Text = "Округ — тест WebView2";
        Width = 960;
        Height = 700;
        BackColor = Color.FromArgb(23, 27, 25);
        if (Environment.GetEnvironmentVariable("KRUG_WEBVIEW_TEST_HIDDEN") == "1")
        {
            ShowInTaskbar = false;
            Opacity = 0;
        }
        Controls.Add(browser);
        Shown += InitializeAsync;
        FormClosed += (_, _) => testAudio?.Dispose();
        Trace("created");
    }

    private async void InitializeAsync(object? sender, EventArgs args)
    {
        try
        {
            Trace("shown");
            var profile = Path.Combine(Path.GetTempPath(), "krug-webview-isolated-prototype");
            var environment = await CoreWebView2Environment.CreateAsync(null, profile);
            Trace("environment");
            await browser.EnsureCoreWebView2Async(environment);
            Trace("ready");
            browser.CoreWebView2.Settings.AreHostObjectsAllowed = false;
            browser.CoreWebView2.Settings.IsWebMessageEnabled = true;
            // This test host never accesses real devices, even if the fixture asks.
            browser.CoreWebView2.PermissionRequested += (_, request) => request.State = CoreWebView2PermissionState.Deny;
            browser.CoreWebView2.ScreenCaptureStarting += (_, request) => { request.Cancel = true; request.Handled = true; };
            browser.CoreWebView2.NavigationStarting += (_, navigation) =>
            {
                Trace("navigation " + navigation.Uri);
                if (!IsTestOrigin(navigation.Uri)) navigation.Cancel = true;
                else { callActive = false; updateGate.ResetCallState(); }
            };
            browser.CoreWebView2.NavigationCompleted += (_, navigation) => Trace($"completed {navigation.IsSuccess} {navigation.WebErrorStatus}");
            browser.CoreWebView2.NewWindowRequested += (_, request) => request.Handled = true;
            browser.CoreWebView2.WebMessageReceived += OnWebMessage;
            var fixture = Environment.GetEnvironmentVariable("KRUG_WEBVIEW_TEST_HTML");
            if (Environment.GetEnvironmentVariable("KRUG_WEBVIEW_TEST_HIDDEN") == "1" && !string.IsNullOrEmpty(fixture))
            {
                browser.CoreWebView2.AddWebResourceRequestedFilter(TestOrigin + "/*", CoreWebView2WebResourceContext.All);
                browser.CoreWebView2.WebResourceRequested += (_, request) =>
                {
                    var script = Environment.GetEnvironmentVariable("KRUG_WEBVIEW_TEST_SCRIPT");
                    var isHtml = request.Request.Uri == TestOrigin + "/";
                    var source = isHtml ? fixture : request.Request.Uri == TestOrigin + "/fixture.js" ? script : null;
                    if (string.IsNullOrEmpty(source)) return;
                    var content = new MemoryStream(File.ReadAllBytes(source));
                    request.Response = environment.CreateWebResourceResponse(content, 200, "OK", $"Content-Type: {(isHtml ? "text/html" : "text/javascript")}; charset=utf-8\r\nCache-Control: no-store");
                };
            }
            using var stream = Assembly.GetExecutingAssembly().GetManifestResourceStream("Krug.Webview.bridge.js")
                ?? throw new InvalidOperationException("Test bridge is missing.");
            using var reader = new StreamReader(stream);
            var bridge = reader.ReadToEnd();
            await browser.CoreWebView2.AddScriptToExecuteOnDocumentCreatedAsync(
                $"if (window.top === window && location.origin === {json.Serialize(TestOrigin)}) {{ {bridge} }}");
            Trace("navigate");
            browser.CoreWebView2.Navigate(TestOrigin);
        }
        catch (Exception error)
        {
            Trace(error.ToString());
            if (Environment.GetEnvironmentVariable("KRUG_WEBVIEW_TEST_HIDDEN") == "1") Console.Error.WriteLine(error);
            else MessageBox.Show(this, error.Message, "Не удалось запустить тест WebView2", MessageBoxButtons.OK, MessageBoxIcon.Error);
            Close();
        }
    }

    private async void OnWebMessage(object? sender, CoreWebView2WebMessageReceivedEventArgs args)
    {
        if (!IsTestOrigin(args.Source) || !IsTestOrigin(browser.CoreWebView2.Source)) return;
        try
        {
            var raw = args.WebMessageAsJson;
            if (raw.Length > 4096) return;
            var message = json.Deserialize<Dictionary<string, object>>(raw);
            var testResult = Environment.GetEnvironmentVariable("KRUG_WEBVIEW_TEST_RESULT");
            var fakeHelper = Environment.GetEnvironmentVariable("KRUG_WEBVIEW_TEST_FAKE_AUDIO_HELPER");
            if (Environment.GetEnvironmentVariable("KRUG_WEBVIEW_TEST_HIDDEN") == "1" && !string.IsNullOrEmpty(fakeHelper) &&
                message != null && message.TryGetValue("type", out var testType) && testType is string testTypeString && testTypeString == "test-audio-start")
            {
                testAudio ??= new AudioCapture(fakeHelper,
                    bytes => browser.CoreWebView2.PostWebMessageAsJson(json.Serialize(new { type = "audio", data = Convert.ToBase64String(bytes) })),
                    () => browser.CoreWebView2.PostWebMessageAsJson(json.Serialize(new { type = "audio-ended" })));
                try { await testAudio.StartAsync(1); }
                catch (Exception) { browser.CoreWebView2.PostWebMessageAsJson("{\"type\":\"test-audio-error\"}"); }
                return;
            }
            if (Environment.GetEnvironmentVariable("KRUG_WEBVIEW_TEST_HIDDEN") == "1" && !string.IsNullOrEmpty(testResult) &&
                message != null && message.TryGetValue("type", out var type) && type is string typeString && typeString == "test-result")
            {
                File.WriteAllText(testResult, raw);
                return;
            }
            if (message is null || !message.TryGetValue("id", out var idValue) || idValue is not int id || id <= 0 ||
                !message.TryGetValue("method", out var methodValue) || methodValue is not string method) return;
            object? result = null;
            string? error = null;
            switch (method)
            {
                case "call-state" when message.TryGetValue("value", out var value) && value is bool active:
                    callActive = active;
                    updateGate.SetCallActive(active);
                    break;
                case "update-state":
                    result = new { state = updateState, callActive };
                    break;
                case "audio-stop":
                    break;
                default:
                    error = "This function is unavailable in the isolated prototype.";
                    break;
            }
            browser.CoreWebView2.PostWebMessageAsJson(json.Serialize(new { type = "result", id, value = result, error }));
        }
        catch (ArgumentException) { }
        catch (InvalidOperationException) { }
    }

    private static void Schedule(Action callback)
    {
        var timer = new System.Windows.Forms.Timer { Interval = 1000 };
        timer.Tick += (_, _) => { timer.Stop(); timer.Dispose(); callback(); };
        timer.Start();
    }

    private void ReportUpdate(string state)
    {
        updateState = state;
        if (browser.CoreWebView2 != null && IsTestOrigin(browser.CoreWebView2.Source))
            browser.CoreWebView2.PostWebMessageAsJson(json.Serialize(new { type = "update", status = new { state } }));
    }
}
