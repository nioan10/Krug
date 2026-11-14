using System.Security.Cryptography;
using System.Text.RegularExpressions;

namespace Krug.Webview;

// Parses only the stable releases and filename format produced by Krug's update feed.
// The caller must fetch both manifest and installer from the configured HTTPS origin.
internal sealed class UpdateManifest
{
    public Version Version { get; }
    public string FileName { get; }
    private readonly byte[] hash;

    private UpdateManifest(Version version, string fileName, byte[] hash)
    {
        Version = version;
        FileName = fileName;
        this.hash = hash;
    }

    public static UpdateManifest Parse(string manifest)
    {
        if (manifest.Length > 8192) throw new InvalidDataException("Update manifest is too large.");
        string Field(string name, string pattern)
        {
            var matches = Regex.Matches(manifest, $@"(?m)^{name}:[ \t]*({pattern})[ \t]*\r?$");
            if (matches.Count != 1) throw new InvalidDataException("Invalid update manifest.");
            return matches[0].Groups[1].Value;
        }
        var versionText = Field("version", @"\d{1,5}\.\d{1,5}\.\d{1,5}");
        if (!System.Version.TryParse(versionText, out var version) || version.Build < 0 || version.Revision != -1)
            throw new InvalidDataException("Invalid update version.");
        var file = Field("path", @"Krug-Setup-\d{1,5}\.\d{1,5}\.\d{1,5}\.exe");
        if (file != $"Krug-Setup-{versionText}.exe") throw new InvalidDataException("Update filename does not match its version.");
        var encoded = Field("sha512", @"[A-Za-z0-9+/]{86}==");
        byte[] hash;
        try { hash = Convert.FromBase64String(encoded); }
        catch (FormatException) { throw new InvalidDataException("Invalid update hash."); }
        if (hash.Length != 64) throw new InvalidDataException("Invalid update hash.");
        return new UpdateManifest(version, file, hash);
    }

    public bool IsNewerThan(Version current) => Version.CompareTo(current) > 0;

    public bool Verify(Stream file)
    {
        using var sha = SHA512.Create();
        var actual = sha.ComputeHash(file);
        var difference = 0;
        for (var i = 0; i < hash.Length; i++) difference |= hash[i] ^ actual[i];
        return difference == 0;
    }
}
