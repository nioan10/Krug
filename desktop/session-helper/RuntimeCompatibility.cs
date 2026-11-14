namespace Krug.Webview;

internal static class RuntimeCompatibility
{
    // ScreenCaptureStarting is available from WebView2 Runtime 131.0.2903.40.
    // https://learn.microsoft.com/en-us/microsoft-edge/webview2/release-notes/sdk/1-0-2903-40
    private static readonly Version Minimum = new(131, 0, 2903, 40);
    public static bool IsSupported(string? value)
    {
        var version = value?.Split(' ')[0];
        return Version.TryParse(version, out var parsed) && parsed >= Minimum;
    }
}
