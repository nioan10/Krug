using System.Runtime.InteropServices;

namespace Krug.Webview;

internal static class WindowTheme
{
    [DllImport("dwmapi.dll")]
    private static extern int DwmSetWindowAttribute(IntPtr window, int attribute, ref int value, int size);

    public static void Apply(IntPtr window)
    {
        // Windows 10 uses attribute 19 on older builds; Windows 11 also supports
        // explicit caption/text colors. Unsupported attributes are harmless.
        try
        {
            var dark = 1;
            if (DwmSetWindowAttribute(window, 20, ref dark, sizeof(int)) != 0)
                DwmSetWindowAttribute(window, 19, ref dark, sizeof(int));
            var caption = 0x00151914; // COLORREF: #141915
            var text = 0x00d6e7dd;    // COLORREF: #dde7d6
            DwmSetWindowAttribute(window, 35, ref caption, sizeof(int));
            DwmSetWindowAttribute(window, 36, ref text, sizeof(int));
        }
        catch (DllNotFoundException) { }
        catch (EntryPointNotFoundException) { }
    }
}
