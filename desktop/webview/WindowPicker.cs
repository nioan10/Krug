using System.Diagnostics;
using System.Drawing;
using System.Runtime.InteropServices;
using System.Text;
using System.Windows.Forms;

namespace Krug.Webview;

// WebView2's system screen picker does not expose its selected window handle.
// Ask separately and explicitly which application's sound may be shared.
internal sealed class WindowPicker : Form
{
    private sealed class WindowItem(IntPtr handle, string title)
    {
        public IntPtr Handle { get; } = handle;
        public string Title { get; } = title;
        public override string ToString() => Title;
    }

    private delegate bool EnumWindowsProc(IntPtr hwnd, IntPtr data);
    [DllImport("user32.dll")] private static extern bool EnumWindows(EnumWindowsProc callback, IntPtr data);
    [DllImport("user32.dll")] private static extern bool IsWindowVisible(IntPtr hwnd);
    [DllImport("user32.dll")] private static extern IntPtr GetWindow(IntPtr hwnd, uint command);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern int GetWindowText(IntPtr hwnd, StringBuilder text, int maxCount);
    [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint processId);

    private readonly ListBox list = new();
    public long? SelectedWindow => list.SelectedItem is WindowItem item ? item.Handle.ToInt64() : null;

    public WindowPicker(IntPtr ownWindow)
    {
        Text = "Звук приложения";
        StartPosition = FormStartPosition.CenterParent;
        FormBorderStyle = FormBorderStyle.FixedDialog;
        MinimizeBox = false; MaximizeBox = false; ShowInTaskbar = false;
        ClientSize = new Size(550, 450);
        BackColor = Color.FromArgb(20, 25, 21);
        ForeColor = Color.FromArgb(221, 231, 214);
        Font = new Font("Segoe UI", 10);
        var title = new Label { Text = "Выберите приложение для звука", Left = 24, Top = 20, Width = 500, Height = 28, Font = new Font(Font, FontStyle.Bold) };
        var description = new Label { Text = "Выберите то же окно, которое показываете. Можно продолжить без звука.", Left = 24, Top = 55, Width = 500, Height = 42, ForeColor = Color.FromArgb(163, 181, 153) };
        list.SetBounds(24, 100, 502, 270);
        list.BackColor = Color.FromArgb(31, 40, 31); list.ForeColor = ForeColor;
        list.BorderStyle = BorderStyle.FixedSingle;
        var share = new Button { Text = "Поделиться звуком", Left = 334, Top = 390, Width = 192, Height = 38, FlatStyle = FlatStyle.Flat,
            BackColor = Color.FromArgb(184, 236, 140), ForeColor = Color.FromArgb(19, 30, 16), DialogResult = DialogResult.OK };
        var silent = new Button { Text = "Без звука", Left = 208, Top = 390, Width = 115, Height = 38, FlatStyle = FlatStyle.Flat,
            BackColor = Color.FromArgb(39, 51, 38), ForeColor = ForeColor, DialogResult = DialogResult.Cancel };
        share.Enabled = false;
        list.SelectedIndexChanged += (_, _) => share.Enabled = list.SelectedItem is WindowItem;
        list.DoubleClick += (_, _) => { if (list.SelectedItem is WindowItem) { DialogResult = DialogResult.OK; Close(); } };
        Controls.AddRange(new Control[] { title, description, list, share, silent });
        AcceptButton = share; CancelButton = silent;
        var windows = new List<WindowItem>();
        var ownPid = (uint)Process.GetCurrentProcess().Id;
        EnumWindows((window, _) =>
        {
            if (window == ownWindow || !IsWindowVisible(window) || GetWindow(window, 4) != IntPtr.Zero) return true;
            if (GetWindowThreadProcessId(window, out var pid) == 0 || pid == ownPid) return true;
            var buffer = new StringBuilder(256);
            if (GetWindowText(window, buffer, buffer.Capacity) <= 0) return true;
            var caption = buffer.ToString().Trim();
            if (caption.Length > 120) caption = caption.Substring(0, 117) + "…";
            if (caption.Length > 0) windows.Add(new WindowItem(window, caption));
            return true;
        }, IntPtr.Zero);
        foreach (var window in windows.OrderBy(item => item.Title, StringComparer.CurrentCultureIgnoreCase)) list.Items.Add(window);
    }
}
