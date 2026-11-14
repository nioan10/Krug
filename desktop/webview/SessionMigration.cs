using System.Net;
using System.Net.Http;
using System.Text;
using System.Text.RegularExpressions;

namespace Krug.Webview;

// Redeems a one-use transfer token and returns the new session cookie for
// insertion into WebView2. No password or old session cookie is transferred.
internal sealed class SessionMigration(HttpClient client, CookieContainer cookies, Uri origin)
{
    public static HttpClient CreateClient(CookieContainer cookies, HttpMessageHandler? handler = null) => new(handler ?? new HttpClientHandler
    {
        AllowAutoRedirect = false,
        UseCookies = true,
        CookieContainer = cookies,
        AutomaticDecompression = DecompressionMethods.None,
    }) { Timeout = TimeSpan.FromSeconds(20) };

    public async Task<Cookie> RedeemAsync(string token, CancellationToken cancellationToken)
    {
        if (origin.Scheme != Uri.UriSchemeHttps || origin.AbsolutePath != "/" || !string.IsNullOrEmpty(origin.UserInfo) ||
            !string.IsNullOrEmpty(origin.Query) || !string.IsNullOrEmpty(origin.Fragment)) throw new InvalidOperationException("Invalid migration origin.");
        if (!Regex.IsMatch(token, @"\A[A-Za-z0-9_-]{43}\z")) throw new InvalidOperationException("Invalid migration token.");
        if (cookies.GetCookies(origin)["__Host-krug"] is not null) throw new InvalidOperationException("Migration cookie container must be empty.");
        using var request = new HttpRequestMessage(HttpMethod.Post, new Uri(origin, "/api/desktop-migration/redeem"));
        request.Headers.TryAddWithoutValidation("Origin", origin.GetLeftPart(UriPartial.Authority));
        request.Content = new StringContent("{\"token\":\"" + token + "\"}", Encoding.UTF8, "application/json");
        using var response = await client.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, cancellationToken);
        if (!response.IsSuccessStatusCode) throw new HttpRequestException("Session migration failed.");
        var cookie = cookies.GetCookies(origin)["__Host-krug"];
        if (cookie is null || !cookie.Secure || !cookie.HttpOnly || cookie.Path != "/" ||
            !string.Equals(cookie.Domain.TrimStart('.'), origin.Host, StringComparison.OrdinalIgnoreCase) ||
            cookie.Expired || cookie.Expires == DateTime.MinValue || cookie.Expires.ToUniversalTime() <= DateTime.UtcNow ||
            string.IsNullOrEmpty(cookie.Value)) throw new InvalidDataException("Invalid migrated session cookie.");
        return cookie;
    }
}
