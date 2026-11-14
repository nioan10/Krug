#if KRUG_PRODUCTION
using System.Windows.Forms;

namespace Krug.Webview;

internal static class DesktopProgram
{
    [STAThread]
    private static void Main(string[] args)
    {
#if KRUG_TEST
        // The isolated installer fixture derives its test paths from its own
        // directory; a shell-launched process need not inherit test variables.
        var installation = new DirectoryInfo(AppDomain.CurrentDomain.BaseDirectory);
        var state = installation.Parent;
        if (installation.Name == "installed" && state != null && state.Name.StartsWith("isolated-state-", StringComparison.Ordinal))
        {
            Environment.SetEnvironmentVariable("KRUG_WEBVIEW_TEST_HTML", Path.Combine(state.FullName, "fixture.html"));
            Environment.SetEnvironmentVariable("KRUG_WEBVIEW_TEST_SCRIPT", Path.Combine(state.FullName, "fixture.js"));
            Environment.SetEnvironmentVariable("KRUG_WEBVIEW_TEST_RESULT", Path.Combine(state.FullName, "webview-result.json"));
            Environment.SetEnvironmentVariable("KRUG_WEBVIEW_TEST_FAKE_AUDIO_HELPER", Path.Combine(installation.FullName, "SyntheticAudio.exe"));
        }
#elif !KRUG_RELEASE
        // The production host is intentionally gated until migration, updates,
        // capture and installer have been verified together.
        if (args.Length != 1 || args[0] != "--experimental") return;
#endif
        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);
        Application.Run(new DesktopWindow());
    }
}
#endif
