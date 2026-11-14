using Krug.Webview;
using System.Security.Cryptography;
using System.Text;
using System.Net;
using System.Net.Http;

var callbacks = new Queue<Action>();
var statuses = new List<string>();
var installs = 0;
var gate = new UpdateGate(callbacks.Enqueue, () => installs++, statuses.Add);
void Check(bool condition, string message) { if (!condition) throw new Exception(message); }

gate.Downloaded();
Check(callbacks.Count == 0, "An unknown call state must not install.");
gate.SetCallActive(true);
Check(statuses.Last() == "ready" && callbacks.Count == 0, "No install may be scheduled without a click.");
gate.SetCallActive(false);
Check(callbacks.Count == 0, "Leaving a call must not install without a request.");
gate.SetCallActive(true);
gate.RequestInstall();
Check(statuses.Last() == "queued" && callbacks.Count == 0, "A requested update must wait for the call.");
gate.SetCallActive(false);
Check(callbacks.Count == 1, "Leaving a call must schedule an update.");
gate.SetCallActive(true);
callbacks.Dequeue()();
Check(installs == 0, "A new call must cancel the scheduled installation.");
gate.SetCallActive(false);
gate.ResetCallState();
callbacks.Dequeue()();
Check(installs == 0, "Navigation must invalidate the old call state.");
gate.SetCallActive(false);
callbacks.Dequeue()();
Check(installs == 1 && statuses.Last() == "installing", "The update must install once after the call.");
gate.SetCallActive(false);
Check(callbacks.Count == 0 && installs == 1, "A completed update must not install twice.");
Console.WriteLine("WebView update gate: passed.");

var payload = Encoding.UTF8.GetBytes("test installer");
var hash = Convert.ToBase64String(SHA512.HashData(payload));
var manifestText = $"version: 0.1.2\nfiles:\n  - url: Krug-Setup-0.1.2.exe\n    sha512: {hash}\npath: Krug-Setup-0.1.2.exe\nsha512: {hash}\n";
var manifest = UpdateManifest.Parse(manifestText);
Check(manifest.IsNewerThan(new Version(0, 1, 1)), "A newer release must be accepted.");
Check(!manifest.IsNewerThan(new Version(0, 1, 2)) && !manifest.IsNewerThan(new Version(0, 2, 0)), "Updates must not downgrade.");
Check(manifest.Verify(new MemoryStream(payload)), "The matching installer must pass its hash.");
Check(!manifest.Verify(new MemoryStream(Encoding.UTF8.GetBytes("tampered"))), "Modified installers must be rejected.");
void Reject(string input)
{
    try { UpdateManifest.Parse(input); throw new Exception("Invalid manifest was accepted."); }
    catch (InvalidDataException) { }
}
Reject(manifestText.Replace("path: Krug-Setup-0.1.2.exe", "path: ../Krug-Setup-0.1.2.exe"));
Reject(manifestText.Replace("path: Krug-Setup-0.1.2.exe", "path: Krug-Setup-0.1.3.exe"));
Reject(manifestText + $"sha512: {hash}\n");
Reject(manifestText.Replace("version: 0.1.2", "version: 0.1.2-beta"));
Console.WriteLine("WebView update manifest and checksum: passed.");

var stage = Path.Combine(Path.GetTempPath(), "krug-update-test-" + Guid.NewGuid().ToString("N"));
var token = new string('a', 43);
var handler = new FakeHandler(manifestText, payload);
using var client = UpdateDownloader.CreateClient(handler);
var downloader = new UpdateDownloader(client, new Uri("https://example.invalid/"), stage);
try
{
    var available = await downloader.CheckAsync(token, new Version(0, 1, 1), CancellationToken.None);
    Check(available != null && handler.Requests == 1, "Checking must not download the installer.");
    var downloaded = await downloader.DownloadAsync(token, available!, CancellationToken.None);
    Check(downloaded != null && File.ReadAllBytes(downloaded.Path).SequenceEqual(payload), "Verified installer must be available.");
    Check(handler.Requests == 2, "The feed and installer must both be requested.");
    File.Delete(downloaded!.Path);
    Check(await downloader.CheckAsync(token, new Version(0, 1, 2), CancellationToken.None) == null, "Existing version must not download again.");
    handler.Payload = Encoding.UTF8.GetBytes("tampered");
    try { await downloader.DownloadAsync(token, available!, CancellationToken.None); throw new Exception("Tampered download was accepted."); }
    catch (InvalidDataException) { }
    Check(!Directory.EnumerateFiles(stage).Any(), "Invalid downloads must be removed.");
    handler.Redirect = true;
    try { await downloader.CheckAsync(token, new Version(0, 1, 1), CancellationToken.None); throw new Exception("Redirect was accepted."); }
    catch (HttpRequestException) { }
}
finally { if (Directory.Exists(stage)) Directory.Delete(stage); }
Console.WriteLine("WebView update download: passed without network access.");

var migrationCookies = new CookieContainer();
using var migrationClient = SessionMigration.CreateClient(migrationCookies, new MigrationHandler(migrationCookies));
var migration = new SessionMigration(migrationClient, migrationCookies, new Uri("https://example.invalid/"));
var sessionCookie = await migration.RedeemAsync(token, CancellationToken.None);
Check(sessionCookie.Name == "__Host-krug" && sessionCookie.HttpOnly && sessionCookie.Secure, "Migrated cookie must be secure and HttpOnly.");
try { await migration.RedeemAsync(token, CancellationToken.None); throw new Exception("Reused cookie container accepted."); }
catch (InvalidOperationException) { }
Console.WriteLine("WebView session redemption: passed without network access.");

sealed class FakeHandler(string manifest, byte[] initialPayload) : HttpMessageHandler
{
    public byte[] Payload = initialPayload;
    public bool Redirect;
    public int Requests;
    protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
    {
        if (request.RequestUri?.Host != "example.invalid" || request.Headers.Authorization?.Scheme != "Bearer" ||
            request.Headers.Authorization.Parameter != new string('a', 43)) throw new Exception("Unexpected update request.");
        Requests++;
        if (Redirect) return Task.FromResult(new HttpResponseMessage(HttpStatusCode.Redirect));
        var bytes = request.RequestUri.AbsolutePath.EndsWith("latest.yml") ? Encoding.UTF8.GetBytes(manifest) : Payload;
        return Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK) { Content = new ByteArrayContent(bytes) });
    }
}

sealed class MigrationHandler(CookieContainer cookies) : HttpMessageHandler
{
    protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
    {
        if (request.Method != HttpMethod.Post || request.RequestUri?.AbsoluteUri != "https://example.invalid/api/desktop-migration/redeem" ||
            !request.Headers.TryGetValues("Origin", out var origin) || origin.Single() != "https://example.invalid" ||
            await request.Content!.ReadAsStringAsync(cancellationToken) != "{\"token\":\"" + new string('a', 43) + "\"}")
            throw new Exception("Unexpected migration request.");
        cookies.Add(new Uri("https://example.invalid/"), new Cookie("__Host-krug", "synthetic", "/") { Secure = true, HttpOnly = true, Expires = DateTime.UtcNow.AddMinutes(1) });
        return new HttpResponseMessage(HttpStatusCode.OK);
    }
}
