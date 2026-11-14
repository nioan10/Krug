using Krug.Webview;
using System.Net;

if (args.Length == 1 && args[0] == "--unprotect-synthetic")
{
    var input = Console.ReadLine() ?? throw new Exception("Missing fixture ticket.");
    Console.WriteLine(SessionTicket.Unprotect(input, DateTimeOffset.UtcNow.ToUnixTimeSeconds()));
    return;
}
var token = new string('a', 43);
var ticket = SessionTicket.Protect(token, 1000);
if (ticket.Contains(token) || SessionTicket.Unprotect(ticket, 1001) != token) throw new Exception("Ticket round trip failed.");
try { SessionTicket.Unprotect(ticket, 1540); throw new Exception("Expired ticket accepted."); }
catch (InvalidDataException) { }
var bytes = Convert.FromBase64String(ticket);
bytes[bytes.Length - 1] ^= 1;
try { SessionTicket.Unprotect(Convert.ToBase64String(bytes), 1001); throw new Exception("Modified ticket accepted."); }
catch (InvalidDataException) { }
try { SessionTicket.Protect("invalid", 1000); throw new Exception("Invalid token accepted."); }
catch (ArgumentException) { }
if (RuntimeCompatibility.IsSupported(null) || RuntimeCompatibility.IsSupported("130.0.2849.80") ||
    RuntimeCompatibility.IsSupported("invalid") || !RuntimeCompatibility.IsSupported("131.0.2903.40") ||
    !RuntimeCompatibility.IsSupported("157.0.4341.46 beta")) throw new Exception("WebView runtime version validation failed.");
var cookies = new CookieContainer();
var origin = new Uri("https://example.invalid/");
cookies.SetCookies(origin, "__Host-krug=synthetic; Max-Age=600; Path=/; HttpOnly; Secure; SameSite=Strict");
var cookie = cookies.GetCookies(origin)["__Host-krug"];
if (cookie == null || !cookie.Secure || !cookie.HttpOnly || cookie.Expires <= DateTime.Now || cookie.Path != "/")
    throw new Exception("Migration cookie parsing failed.");
Console.WriteLine("DPAPI session ticket: passed with synthetic token.");
