using System.Net;
using System.Net.Http;
using System.Text;
using System.Text.RegularExpressions;
using System.Web.Script.Serialization;

namespace Krug.Webview;

internal static class UpdateAccess
{
    public static HttpClient CreateClient(CookieContainer cookies, HttpMessageHandler? handler = null) => new(handler ?? new HttpClientHandler
    {
        AllowAutoRedirect = false, UseCookies = true, CookieContainer = cookies, AutomaticDecompression = DecompressionMethods.None,
    }) { Timeout = TimeSpan.FromSeconds(20) };

    public static async Task<string> GetTokenAsync(HttpClient client, Uri origin, CancellationToken cancellationToken)
    {
        if (origin.Scheme != Uri.UriSchemeHttps || origin.AbsolutePath != "/" || !string.IsNullOrEmpty(origin.UserInfo) ||
            !string.IsNullOrEmpty(origin.Query) || !string.IsNullOrEmpty(origin.Fragment)) throw new InvalidOperationException("Invalid update origin.");
        using var request = new HttpRequestMessage(HttpMethod.Get, new Uri(origin, "/api/desktop-updates/access"));
        request.Headers.TryAddWithoutValidation("X-Krug-Desktop-Capability", "manual-v1");
        using var response = await client.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, cancellationToken);
        if (!response.IsSuccessStatusCode) throw new HttpRequestException("Update access unavailable.");
        using var input = await response.Content.ReadAsStreamAsync();
        var bytes = new byte[2049];
        var used = 0;
        while (used < bytes.Length)
        {
            var read = await input.ReadAsync(bytes, used, bytes.Length - used, cancellationToken);
            if (read == 0) break;
            used += read;
        }
        if (used == bytes.Length) throw new InvalidDataException("Invalid update access response.");
        var json = new JavaScriptSerializer { MaxJsonLength = 2048, RecursionLimit = 4 };
        var data = json.Deserialize<Dictionary<string, object>>(new UTF8Encoding(false, true).GetString(bytes, 0, used));
        if (data is null || !data.TryGetValue("token", out var value) || value is not string token ||
            !Regex.IsMatch(token, @"\A[A-Za-z0-9_-]{43}\z")) throw new InvalidDataException("Invalid update token.");
        return token;
    }
}
