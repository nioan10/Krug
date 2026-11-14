using System.Net;
using Microsoft.Web.WebView2.Core;

namespace Krug.Webview;

// Called before the first navigation. A failed or expired ticket never replaces
// an existing WebView2 session and never prevents the normal login screen.
internal static class MigrationRestore
{
    public static async Task TryRestoreAsync(CoreWebView2CookieManager manager, Uri origin)
    {
        var path = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "KrugMigration", "migration.ticket");
        if (!File.Exists(path)) return;
        try
        {
            var existing = await manager.GetCookiesAsync(origin.AbsoluteUri);
            if (existing.Any(cookie => cookie.Name == "__Host-krug")) { File.Delete(path); return; }
            if (new FileInfo(path).Length > 4096) { File.Delete(path); return; }
            string token;
            try { token = SessionTicket.Unprotect(File.ReadAllText(path), DateTimeOffset.UtcNow.ToUnixTimeSeconds()); }
            catch (InvalidDataException) { File.Delete(path); return; }
            var cookies = new CookieContainer();
            using var client = SessionMigration.CreateClient(cookies);
            var session = await new SessionMigration(client, cookies, origin).RedeemAsync(token, CancellationToken.None);
            var webCookie = manager.CreateCookieWithSystemNetCookie(session);
            webCookie.SameSite = CoreWebView2CookieSameSiteKind.Strict;
            manager.AddOrUpdateCookie(webCookie);
            File.Delete(path);
        }
        catch (IOException) { }
        catch (UnauthorizedAccessException) { }
        catch (System.Net.Http.HttpRequestException) { }
        catch (TaskCanceledException) { }
        catch (InvalidDataException) { }
    }
}
