using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;

namespace Krug.Webview;

// Only the same Windows user can read a ticket. The server also enforces a
// short expiry, source-session validity and single use on redemption.
internal static class SessionTicket
{
    private static readonly byte[] Entropy = Encoding.UTF8.GetBytes("website.nioservices.krug.desktop-session-transfer.v1");
    // Allow time for an NSIS upgrade to complete and the new host to start.
    private const long LifetimeSeconds = 9 * 60;

    public static string Protect(string token, long now)
    {
        if (!Regex.IsMatch(token, @"\A[A-Za-z0-9_-]{43}\z")) throw new ArgumentException("Invalid migration token.");
        var bytes = Encoding.UTF8.GetBytes($"v1\n{now + LifetimeSeconds}\n{token}");
        try { return Convert.ToBase64String(ProtectedData.Protect(bytes, Entropy, DataProtectionScope.CurrentUser)); }
        finally { Array.Clear(bytes, 0, bytes.Length); }
    }

    public static string Unprotect(string ticket, long now)
    {
        if (ticket.Length > 4096) throw new InvalidDataException("Invalid session ticket.");
        byte[] protectedBytes;
        try { protectedBytes = Convert.FromBase64String(ticket); }
        catch (FormatException) { throw new InvalidDataException("Invalid session ticket."); }
        byte[] plain;
        try { plain = ProtectedData.Unprotect(protectedBytes, Entropy, DataProtectionScope.CurrentUser); }
        catch (CryptographicException) { throw new InvalidDataException("Invalid session ticket."); }
        try
        {
            var parts = Encoding.UTF8.GetString(plain).Split('\n');
            if (parts.Length != 3 || parts[0] != "v1" || !long.TryParse(parts[1], out var expires) ||
                expires <= now || expires > now + LifetimeSeconds || !Regex.IsMatch(parts[2], @"\A[A-Za-z0-9_-]{43}\z"))
                throw new InvalidDataException("Expired or invalid session ticket.");
            return parts[2];
        }
        finally { Array.Clear(plain, 0, plain.Length); }
    }
}
