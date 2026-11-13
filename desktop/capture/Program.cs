using System.Diagnostics;
using System.Runtime.Versioning;
using System.Threading.Channels;
using System.Runtime.InteropServices;
using NAudio.CoreAudioApi;
using NAudio.Wave;

// Internal helper: raw 44.1 kHz stereo float PCM on stdout, diagnostics on stderr.
// It is started only after a user has explicitly selected a process.
[SupportedOSPlatform("windows")]
static class Program
{
    [DllImport("user32.dll")]
    static extern uint GetWindowThreadProcessId(nint window, out uint processId);

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    static extern bool IsWindow(nint window);

    static async Task<int> Main(string[] args)
    {
        if (args.Length == 2 && args[0] == "--window" && long.TryParse(args[1], out var handle) && handle > 0)
        {
            var window = (nint)handle;
            if (!IsWindow(window) || GetWindowThreadProcessId(window, out var processId) == 0 || processId == 0)
            {
                Console.Error.WriteLine("Selected window no longer exists.");
                return 1;
            }
            try
            {
                using var process = Process.GetProcessById((int)processId);
                Console.WriteLine($"{processId} {process.StartTime.ToUniversalTime().Ticks}");
            }
            catch (Exception error) { Console.Error.WriteLine($"Selected process is unavailable: {error.Message}"); return 1; }
            return 0;
        }
        if (!OperatingSystem.IsWindowsVersionAtLeast(10, 0, 20348))
        {
            Console.Error.WriteLine("Process audio capture requires Windows build 20348 or newer.");
            return 1;
        }
        if (args.Length != 2 || !int.TryParse(args[0], out var pid) || pid <= 0 || pid == Environment.ProcessId || !long.TryParse(args[1], out var expectedStart))
        {
            Console.Error.WriteLine("Usage: Krug.Capture <selected-process-id> <start-time-ticks>");
            return 2;
        }

        try
        {
            using var target = Process.GetProcessById(pid);
            // Keep a handle to the original process: a reused PID must never become a new target.
            _ = target.Handle;
            if (target.StartTime.ToUniversalTime().Ticks != expectedStart) throw new InvalidOperationException("Selected process has changed.");
            if (target.HasExited) throw new InvalidOperationException("Selected process has exited.");
            await using var recorder = await new WasapiRecorderBuilder()
                .WithProcessLoopback((uint)pid, ProcessLoopbackMode.IncludeTargetProcessTree)
                .WithFormat(WaveFormat.CreateIeeeFloatWaveFormat(44100, 2))
                .BuildAsync();
            if (target.HasExited) throw new InvalidOperationException("Selected process has exited.");

            using var stop = new CancellationTokenSource();
            var packets = Channel.CreateBounded<byte[]>(new BoundedChannelOptions(24)
            {
                SingleReader = true, SingleWriter = true, FullMode = BoundedChannelFullMode.DropOldest
            });
            recorder.DataAvailable += (buffer, flags, _, _) =>
            {
                if (buffer.IsEmpty) return;
                var packet = buffer.ToArray();
                if ((flags & AudioClientBufferFlags.Silent) != 0) Array.Clear(packet);
                packets.Writer.TryWrite(packet);
            };
            Exception? recordingError = null;
            recorder.RecordingStopped += (_, eventArgs) =>
            {
                recordingError = eventArgs.Exception;
                try { stop.Cancel(); } catch (ObjectDisposedException) { }
            };
            recorder.StartRecording();
            Console.Error.WriteLine("READY 44100 2 f32le");

            var output = Console.OpenStandardOutput();
            var writer = Task.Run(async () =>
            {
                await foreach (var packet in packets.Reader.ReadAllAsync(stop.Token))
                    await output.WriteAsync(packet, stop.Token);
            });
            var exited = target.WaitForExitAsync(stop.Token);
            // Closing stdin or sending a line stops capture, including when the parent exits.
            // Console.In may implement ReadLineAsync synchronously for redirected pipes.
            // Keep the blocking read on a background thread so process-exit monitoring runs.
            var parentStop = Task.Run(() => Console.In.ReadLine());
            await Task.WhenAny(writer, exited, parentStop);
            stop.Cancel();
            recorder.StopRecording();
            packets.Writer.TryComplete();
            // A broken or stalled parent can leave an anonymous-pipe write blocked;
            // never wait indefinitely for it during shutdown.
            if (writer.IsCompleted) { try { await writer; } catch (OperationCanceledException) { } }
            if (recordingError is not null) throw recordingError;
            return 0;
        }
        catch (Exception error)
        {
            Console.Error.WriteLine($"Capture failed: {error.Message}");
            return 1;
        }
    }
}
