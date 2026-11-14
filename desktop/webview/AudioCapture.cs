using System.Diagnostics;
using System.Globalization;
using System.Text.RegularExpressions;

namespace Krug.Webview;

// Wraps the existing process-loopback helper. The caller must first obtain an
// explicit user selection; no system-wide or default audio fallback exists.
internal sealed class AudioCapture(string helper, Action<byte[]> onAudio, Action onEnded) : IDisposable
{
    private volatile Process? process;
    private bool starting;
    private int generation;
    private readonly SynchronizationContext? context = SynchronizationContext.Current;

    public async Task StartAsync(long window)
    {
        if (window <= 0) throw new ArgumentException("Invalid window.");
        if (starting || process != null) throw new InvalidOperationException("Capture is already active.");
        starting = true;
        var currentGeneration = Volatile.Read(ref generation);
        try
        {
            using var lookup = NewProcess("--window " + window.ToString(CultureInfo.InvariantCulture));
            if (!lookup.Start()) throw new InvalidOperationException("Window lookup failed.");
            var output = lookup.StandardOutput.ReadToEndAsync();
            var exit = WaitForExit(lookup);
            if (await Task.WhenAny(exit, Task.Delay(5000)) != exit) { TryKill(lookup); throw new TimeoutException("Window lookup timed out."); }
            if (lookup.ExitCode != 0) throw new InvalidOperationException("Selected application is unavailable.");
            var selected = (await output).Trim();
            if (Volatile.Read(ref generation) != currentGeneration) throw new OperationCanceledException();
            if (!Regex.IsMatch(selected, @"\A[1-9]\d{0,9} [1-9]\d{0,18}\z")) throw new InvalidDataException("Invalid selected process.");
            var child = NewProcess(selected);
            if (!child.Start()) { child.Dispose(); throw new InvalidOperationException("Audio capture failed to start."); }
            process = child;
            if (Volatile.Read(ref generation) != currentGeneration) { Stop(); throw new OperationCanceledException(); }
            var ready = child.StandardError.ReadLineAsync();
            if (await Task.WhenAny(ready, Task.Delay(8000), WaitForExit(child)) != ready ||
                await ready != "READY 44100 2 f32le" || child.HasExited)
            {
                Stop();
                throw new InvalidOperationException("Audio capture failed to start.");
            }
            if (Volatile.Read(ref generation) != currentGeneration) { Stop(); throw new OperationCanceledException(); }
            _ = PumpAsync(child);
        }
        finally { starting = false; }
    }

    public void Stop()
    {
        Interlocked.Increment(ref generation);
        var child = process;
        process = null;
        if (child is null) return;
        try { child.StandardInput.WriteLine(); child.StandardInput.Close(); } catch (IOException) { } catch (InvalidOperationException) { }
        _ = StopChild(child);
    }

    private async Task PumpAsync(Process child)
    {
        try
        {
            var input = child.StandardOutput.BaseStream;
            var buffer = new byte[8192];
            int read;
            while ((read = await input.ReadAsync(buffer, 0, buffer.Length)) > 0)
            {
                if (process != child) break;
                var packet = new byte[read];
                Buffer.BlockCopy(buffer, 0, packet, 0, read);
                await Dispatch(() => { if (process == child) onAudio(packet); });
            }
        }
        catch (IOException) { }
        catch (ObjectDisposedException) { }
        finally
        {
            await Dispatch(() =>
            {
                if (process != child) return;
                process = null;
                _ = StopChild(child);
                onEnded();
            });
        }
    }

    private Task Dispatch(Action action)
    {
        if (context is null) { action(); return Task.CompletedTask; }
        var done = new TaskCompletionSource<bool>();
        context.Post(_ => { try { action(); done.TrySetResult(true); } catch (Exception error) { done.TrySetException(error); } }, null);
        return done.Task;
    }

    private Process NewProcess(string args) => new()
    {
        StartInfo = new ProcessStartInfo(helper, args)
        {
            UseShellExecute = false, CreateNoWindow = true, RedirectStandardInput = true,
            RedirectStandardOutput = true, RedirectStandardError = true,
        },
    };

    private static Task WaitForExit(Process child) => Task.Run(() => { try { child.WaitForExit(); } catch (InvalidOperationException) { } });
    private static void TryKill(Process child) { try { if (!child.HasExited) child.Kill(); } catch (InvalidOperationException) { } catch (System.ComponentModel.Win32Exception) { } }
    private static async Task StopChild(Process child)
    {
        try { var exit = WaitForExit(child); if (await Task.WhenAny(exit, Task.Delay(1000)) != exit) TryKill(child); }
        finally { child.Dispose(); }
    }
    public void Dispose() => Stop();
}
