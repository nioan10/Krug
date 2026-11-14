using Krug.Webview;
using Microsoft.Web.WebView2.Core;

// Internal migration helper: read the short-lived token from a pipe, never the
// command line; only the DPAPI-protected ticket is written to stdout.
if (args.Length != 1) return 2;
if (args[0] == "--check-runtime")
{
    try { return RuntimeCompatibility.IsSupported(CoreWebView2Environment.GetAvailableBrowserVersionString()) ? 0 : 1; }
    catch (Exception) { return 1; }
}
if (args[0] != "--protect") return 2;
try
{
    var token = Console.ReadLine();
    if (token is null || token.Length != 43) return 2;
    Console.WriteLine(SessionTicket.Protect(token, DateTimeOffset.UtcNow.ToUnixTimeSeconds()));
    return 0;
}
catch (Exception) { Console.Error.WriteLine("Unable to protect migration ticket."); return 1; }
