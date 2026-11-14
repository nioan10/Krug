namespace Krug.Webview;

// All calls and scheduled callbacks run on the UI thread. A fresh page must
// explicitly report call state before a downloaded update may be installed.
internal sealed class UpdateGate(Action<Action> schedule, Action install, Action<string> report)
{
    private bool? inCall;
    private bool ready;
    private bool scheduled;

    public void SetCallActive(bool value)
    {
        inCall = value;
        if (ready) report(value ? "queued" : "ready");
        MaybeInstall();
    }

    public void Downloaded()
    {
        ready = true;
        report(inCall == true ? "queued" : "ready");
        MaybeInstall();
    }

    public void ResetCallState() => inCall = null;

    private void MaybeInstall()
    {
        if (!ready || inCall != false || scheduled) return;
        scheduled = true;
        schedule(() =>
        {
            scheduled = false;
            if (!ready || inCall != false) return;
            ready = false;
            report("installing");
            install();
        });
    }
}
