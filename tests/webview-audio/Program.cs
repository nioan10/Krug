using System.Reflection;
using System.Net;
using System.Net.Http;
using Krug.Webview;

// This executable also acts as a synthetic helper; it never accesses devices.
if (args.Length == 2 && args[0] == "--window")
{
    if (args[1] == "3") await Task.Delay(700);
    Console.WriteLine($"{args[1]} 123456789");
    return;
}
if (args.Length == 2)
{
    Console.Error.WriteLine("READY 44100 2 f32le");
    var output = Console.OpenStandardOutput();
    if (args[0] == "4")
    {
        for (var frame = 0; frame < 500; frame++)
        {
            var samples = new byte[441 * 2 * sizeof(float)];
            for (var i = 0; i < 441; i++)
            {
                var value = (float)(0.1 * Math.Sin(2 * Math.PI * 440 * (frame * 441 + i) / 44100));
                var bytes = BitConverter.GetBytes(value);
                Buffer.BlockCopy(bytes, 0, samples, i * 8, 4);
                Buffer.BlockCopy(bytes, 0, samples, i * 8 + 4, 4);
            }
            await output.WriteAsync(samples, 0, samples.Length);
            await output.FlushAsync();
            await Task.Delay(10);
        }
        return;
    }
    output.Write(new byte[] { 1, 2, 3, 4, 5, 6, 7, 8 }, 0, 8);
    output.Flush();
    if (args[0] == "2") await Task.Delay(300);
    else Console.ReadLine();
    return;
}

var helper = Assembly.GetExecutingAssembly().Location;
var packet = new TaskCompletionSource<byte[]>();
var ended = new TaskCompletionSource<bool>();
using (var capture = new AudioCapture(helper, bytes => packet.TrySetResult(bytes), () => ended.TrySetResult(true)))
{
    await capture.StartAsync(1);
    if (await Task.WhenAny(packet.Task, Task.Delay(5000)) != packet.Task || !packet.Task.Result.SequenceEqual(new byte[] { 1, 2, 3, 4, 5, 6, 7, 8 }))
        throw new Exception("Synthetic PCM was not forwarded.");
    try { await capture.StartAsync(1); throw new Exception("Duplicate capture accepted."); }
    catch (InvalidOperationException) { }
    capture.Stop();
    await Task.Delay(200);
    if (ended.Task.IsCompleted) throw new Exception("Explicit stop was reported as an unexpected ending.");
}
var exit = new TaskCompletionSource<bool>();
using (var capture = new AudioCapture(helper, _ => { }, () => exit.TrySetResult(true)))
{
    await capture.StartAsync(2);
    if (await Task.WhenAny(exit.Task, Task.Delay(5000)) != exit.Task) throw new Exception("Exited target was not reported.");
}
using (var capture = new AudioCapture(helper, _ => throw new Exception("Cancelled capture emitted audio."), () => { }))
{
    var start = capture.StartAsync(3);
    await Task.Delay(150);
    capture.Stop();
    try { await start; throw new Exception("Cancelled capture started."); }
    catch (OperationCanceledException) { }
}
Console.WriteLine("Synthetic process audio lifecycle: passed; no devices accessed.");
using (var client = UpdateAccess.CreateClient(new CookieContainer(), new FakeAccess()))
{
    var access = await UpdateAccess.GetTokenAsync(client, new Uri("https://example.invalid/"), CancellationToken.None);
    if (access != new string('a', 43)) throw new Exception("Update access token was not read.");
}
Console.WriteLine("Update access: passed without network access.");

sealed class FakeAccess : HttpMessageHandler
{
    protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
    {
        if (request.Method != HttpMethod.Get || request.RequestUri?.AbsoluteUri != "https://example.invalid/api/desktop-updates/access" ||
            !request.Headers.TryGetValues("X-Krug-Desktop-Capability", out var capabilities) || capabilities.Single() != "manual-v1")
            throw new Exception("Wrong access request.");
        return Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK) { Content = new StringContent("{\"token\":\"" + new string('a', 43) + "\"}") });
    }
}
