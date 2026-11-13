using System.Drawing;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

namespace Krug.Webview;

// Isolated prototype only: it cannot access the real server or publish media.
internal sealed class MainWindow : Form
{
    private const string TestOrigin = "http://127.0.0.1:9350";
    private readonly WebView2 browser = new() { Dock = DockStyle.Fill };

    public MainWindow()
    {
        Text = "Округ — тест WebView2";
        Width = 960;
        Height = 700;
        BackColor = Color.FromArgb(23, 27, 25);
        Controls.Add(browser);
        Shown += InitializeAsync;
    }

    private async void InitializeAsync(object? sender, EventArgs args)
    {
        try
        {
            var profile = Path.Combine(Path.GetTempPath(), "krug-webview-isolated-prototype");
            var environment = await CoreWebView2Environment.CreateAsync(null, profile);
            await browser.EnsureCoreWebView2Async(environment);
            browser.CoreWebView2.Settings.AreHostObjectsAllowed = false;
            browser.CoreWebView2.Settings.IsWebMessageEnabled = false;
            browser.CoreWebView2.NavigationStarting += (_, navigation) =>
            {
                if (!Uri.TryCreate(navigation.Uri, UriKind.Absolute, out var uri) ||
                    !string.Equals(uri.GetLeftPart(UriPartial.Authority), TestOrigin, StringComparison.Ordinal)) navigation.Cancel = true;
            };
            browser.CoreWebView2.NewWindowRequested += (_, request) => request.Handled = true;
            browser.CoreWebView2.Navigate(TestOrigin);
        }
        catch (Exception error)
        {
            MessageBox.Show(this, error.Message, "Не удалось запустить тест WebView2", MessageBoxButtons.OK, MessageBoxIcon.Error);
            Close();
        }
    }
}
