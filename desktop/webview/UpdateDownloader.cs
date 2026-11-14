using System.Net;
using System.Net.Http;
using System.Net.Http.Headers;
using System.Text;
using System.Text.RegularExpressions;

namespace Krug.Webview;

// Used only by a future production host. The supplied client must not follow
// redirects: scoped bearer credentials must never be sent to another origin.
internal sealed class UpdateDownloader(HttpClient client, Uri origin, string stagingDirectory)
{
    public sealed class Downloaded(UpdateManifest manifest, string path)
    {
        public UpdateManifest Manifest { get; } = manifest;
        public string Path { get; } = path;
    }
    private const long MaxInstallerBytes = 250L * 1024 * 1024;
    private const int MaxManifestBytes = 8192;

    public static HttpClient CreateClient(HttpMessageHandler? handler = null) => new(handler ?? new HttpClientHandler
    {
        AllowAutoRedirect = false,
        AutomaticDecompression = DecompressionMethods.None,
        UseCookies = false,
    }) { Timeout = TimeSpan.FromMinutes(10) };

    public async Task<Downloaded?> DownloadAsync(string token, Version current, CancellationToken cancellationToken, IProgress<int>? progress = null)
    {
        if (origin.Scheme != Uri.UriSchemeHttps || origin.AbsolutePath != "/" || !string.IsNullOrEmpty(origin.Query) ||
            !string.IsNullOrEmpty(origin.Fragment) || !string.IsNullOrEmpty(origin.UserInfo)) throw new InvalidOperationException("Invalid update origin.");
        if (!Regex.IsMatch(token, @"\A[A-Za-z0-9_-]{43}\z")) throw new InvalidOperationException("Invalid update token.");
        using var manifestRequest = Request(new Uri(origin, "/api/desktop-updates/latest.yml"), token);
        using var manifestResponse = await client.SendAsync(manifestRequest, HttpCompletionOption.ResponseHeadersRead, cancellationToken);
        EnsureSuccess(manifestResponse);
        using var manifestStream = await manifestResponse.Content.ReadAsStreamAsync();
        var data = await ReadBounded(manifestStream, MaxManifestBytes, cancellationToken);
        var manifest = UpdateManifest.Parse(new UTF8Encoding(false, true).GetString(data));
        if (!manifest.IsNewerThan(current)) return null;
        using var request = Request(new Uri(origin, "/api/desktop-updates/" + manifest.FileName), token);
        using var response = await client.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, cancellationToken);
        EnsureSuccess(response);
        var length = response.Content.Headers.ContentLength;
        if (length is <= 0 or > MaxInstallerBytes) throw new InvalidDataException("Invalid installer size.");
        Directory.CreateDirectory(stagingDirectory);
        var path = Path.Combine(stagingDirectory, "krug-update-" + Guid.NewGuid().ToString("N") + ".exe");
        try
        {
            using (var input = await response.Content.ReadAsStreamAsync())
            using (var output = new FileStream(path, FileMode.CreateNew, FileAccess.Write, FileShare.None, 81920, true))
            {
                var buffer = new byte[81920];
                long count = 0;
                var lastPercent = -1;
                int read;
                while ((read = await input.ReadAsync(buffer, 0, buffer.Length, cancellationToken)) != 0)
                {
                    count += read;
                    if (count > MaxInstallerBytes) throw new InvalidDataException("Installer is too large.");
                    await output.WriteAsync(buffer, 0, read, cancellationToken);
                    var percent = length.HasValue ? (int)Math.Min(100, count * 100 / length.Value) : 0;
                    if (percent != lastPercent) { lastPercent = percent; progress?.Report(percent); }
                }
                if (count == 0 || (length.HasValue && count != length.Value)) throw new InvalidDataException("Incomplete installer.");
            }
            using (var file = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.Read))
                if (!manifest.Verify(file)) throw new InvalidDataException("Installer hash mismatch.");
            return new Downloaded(manifest, path);
        }
        catch { try { File.Delete(path); } catch (IOException) { } throw; }
    }

    private static HttpRequestMessage Request(Uri uri, string token)
    {
        var request = new HttpRequestMessage(HttpMethod.Get, uri);
        request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", token);
        return request;
    }

    private static void EnsureSuccess(HttpResponseMessage response)
    {
        if (!response.IsSuccessStatusCode) throw new HttpRequestException("Update feed request failed.");
    }

    private static async Task<byte[]> ReadBounded(Stream input, int limit, CancellationToken cancellationToken)
    {
        using var output = new MemoryStream();
        var buffer = new byte[2048];
        int read;
        while ((read = await input.ReadAsync(buffer, 0, buffer.Length, cancellationToken)) != 0)
        {
            if (output.Length + read > limit) throw new InvalidDataException("Update manifest is too large.");
            output.Write(buffer, 0, read);
        }
        return output.ToArray();
    }
}
