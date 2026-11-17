// Bitwarden MCP Settings
// Copyright (C) 2026 ShadowsDistant. Licensed under the GNU GPL v3 or later.
//
// The settings model and the small pure helpers around it. Mirrors src/settings.ts; keep the two
// in step. Written for C# 5 so the .NET Framework's own compiler can build it: no string
// interpolation, no ?. operator, no expression-bodied members, and no non-ASCII characters in
// source (they are built from code points where needed).

using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Text;
using System.Text.RegularExpressions;
using System.Web.Script.Serialization;

namespace BitwardenMcpSettings
{
    public sealed class SettingsModel
    {
        public bool Cards = true;
        public bool AllowChanges = true;
        public bool AllowTrash = true;
        public string Access = "ask";
        public List<string> TrustedSites = new List<string>();
        /** "idle", "exit" or "never". */
        public string LockMode = "exit";
        /** Used when LockMode is idle. Always 1 to 1440 here, so switching back to idle restores it. */
        public int IdleLockMinutes = 15;
        public int RevealSeconds = 30;
        public int ClipboardClearSeconds = 30;
        public bool UpdateCheck = true;
        /** Whether the server keeps activity.jsonl, the history shown on the Activity page. */
        public bool ActivityLog = true;
        /** App-only: "system", "light" or "dark". The server ignores it. */
        public string Theme = "system";
        /** App-only: "on", "off" or "system". On by default: motion is part of how the app reads. */
        public string Animations = "on";
        /** Keys this version does not know, carried through a save untouched. */
        public Dictionary<string, object> Extra = new Dictionary<string, object>();

        public static readonly string[] Known =
        {
            "cards", "allowChanges", "allowTrash", "access", "trustedSites", "lockMode", "idleLockMinutes",
            "revealSeconds", "clipboardClearSeconds", "updateCheck", "activityLog", "theme", "animations"
        };

        public SettingsModel Clone()
        {
            SettingsModel c = (SettingsModel)MemberwiseClone();
            c.TrustedSites = new List<string>(TrustedSites);
            c.Extra = new Dictionary<string, object>(Extra);
            return c;
        }

        static int Clamp(double v, int lo, int hi)
        {
            int n = (int)Math.Round(v);
            return Math.Min(hi, Math.Max(lo, n));
        }

        public static bool TryNumber(object v, out double d)
        {
            d = 0;
            if (v == null || v is bool || v is string) return false;
            try
            {
                d = Convert.ToDouble(v, CultureInfo.InvariantCulture);
                return !double.IsNaN(d) && !double.IsInfinity(d);
            }
            catch
            {
                return false;
            }
        }

        public static string NormaliseAccess(object v)
        {
            string s = (v as string ?? "").Trim().ToLowerInvariant();
            if (s == "never" || s == "off") return "never";
            if (s == "ask" || s == "session") return s;
            return null;
        }

        static string OneOf(object v, params string[] allowed)
        {
            string s = (v as string ?? "").Trim().ToLowerInvariant();
            return Array.IndexOf(allowed, s) >= 0 ? s : null;
        }

        /** Applies whatever a parsed JSON object holds over these values, key by key. */
        public void Apply(IDictionary<string, object> d, List<string> warnings)
        {
            object v;
            double n;
            if (d.TryGetValue("cards", out v)) { if (v is bool) Cards = (bool)v; else warnings.Add("cards"); }
            if (d.TryGetValue("allowChanges", out v)) { if (v is bool) AllowChanges = (bool)v; else warnings.Add("allowChanges"); }
            if (d.TryGetValue("allowTrash", out v)) { if (v is bool) AllowTrash = (bool)v; else warnings.Add("allowTrash"); }
            if (d.TryGetValue("updateCheck", out v)) { if (v is bool) UpdateCheck = (bool)v; else warnings.Add("updateCheck"); }
            if (d.TryGetValue("activityLog", out v)) { if (v is bool) ActivityLog = (bool)v; else warnings.Add("activityLog"); }
            if (d.TryGetValue("access", out v))
            {
                string a = NormaliseAccess(v);
                if (a != null) Access = a; else warnings.Add("access");
            }
            if (d.TryGetValue("trustedSites", out v))
            {
                object[] arr = v as object[];
                System.Collections.ArrayList list = v as System.Collections.ArrayList;
                if (arr == null && list != null) arr = list.ToArray();
                if (arr != null)
                {
                    TrustedSites = new List<string>();
                    foreach (object o in arr) if (o != null) TrustedSites.Add(Convert.ToString(o, CultureInfo.InvariantCulture));
                }
                else warnings.Add("trustedSites");
            }

            // Locking. A file from before lockMode existed said everything with idleLockMinutes:
            // a positive number meant an idle lock, zero meant only when the app closes.
            int idle = -1;
            if (d.TryGetValue("idleLockMinutes", out v))
            {
                if (TryNumber(v, out n)) idle = Clamp(n, 0, 1440); else warnings.Add("idleLockMinutes");
            }
            string mode = null;
            if (d.TryGetValue("lockMode", out v))
            {
                mode = OneOf(v, "idle", "exit", "never");
                if (mode == null) warnings.Add("lockMode");
            }
            if (mode != null) LockMode = mode;
            else if (idle >= 0) LockMode = idle > 0 ? "idle" : "exit";
            if (idle > 0) IdleLockMinutes = idle;

            if (d.TryGetValue("revealSeconds", out v)) { if (TryNumber(v, out n)) RevealSeconds = Clamp(n, 5, 300); else warnings.Add("revealSeconds"); }
            if (d.TryGetValue("clipboardClearSeconds", out v)) { if (TryNumber(v, out n)) ClipboardClearSeconds = Clamp(n, 5, 300); else warnings.Add("clipboardClearSeconds"); }
            if (d.TryGetValue("theme", out v))
            {
                string t = OneOf(v, "system", "light", "dark");
                if (t != null) Theme = t; else warnings.Add("theme");
            }
            if (d.TryGetValue("animations", out v))
            {
                string a = OneOf(v, "on", "off", "system");
                if (a != null) Animations = a; else warnings.Add("animations");
            }
        }

        static string B(bool b) { return b ? "true" : "false"; }
        static string N(int n) { return n.ToString(CultureInfo.InvariantCulture); }

        public string ToJson()
        {
            StringBuilder sb = new StringBuilder();
            sb.Append("{\n");
            sb.Append("  \"cards\": ").Append(B(Cards)).Append(",\n");
            sb.Append("  \"allowChanges\": ").Append(B(AllowChanges)).Append(",\n");
            sb.Append("  \"allowTrash\": ").Append(B(AllowTrash)).Append(",\n");
            sb.Append("  \"access\": ").Append(Json.Quote(Access)).Append(",\n");
            sb.Append("  \"trustedSites\": [");
            for (int i = 0; i < TrustedSites.Count; i++)
            {
                sb.Append(i == 0 ? "\n    " : ",\n    ").Append(Json.Quote(TrustedSites[i]));
            }
            sb.Append(TrustedSites.Count > 0 ? "\n  ],\n" : "],\n");
            sb.Append("  \"lockMode\": ").Append(Json.Quote(LockMode)).Append(",\n");
            sb.Append("  \"idleLockMinutes\": ").Append(N(IdleLockMinutes)).Append(",\n");
            sb.Append("  \"revealSeconds\": ").Append(N(RevealSeconds)).Append(",\n");
            sb.Append("  \"clipboardClearSeconds\": ").Append(N(ClipboardClearSeconds)).Append(",\n");
            sb.Append("  \"updateCheck\": ").Append(B(UpdateCheck)).Append(",\n");
            sb.Append("  \"activityLog\": ").Append(B(ActivityLog)).Append(",\n");
            sb.Append("  \"theme\": ").Append(Json.Quote(Theme)).Append(",\n");
            sb.Append("  \"animations\": ").Append(Json.Quote(Animations));
            JavaScriptSerializer js = new JavaScriptSerializer();
            foreach (KeyValuePair<string, object> kv in Extra)
            {
                sb.Append(",\n  ").Append(Json.Quote(kv.Key)).Append(": ").Append(js.Serialize(kv.Value));
            }
            sb.Append("\n}\n");
            return sb.ToString();
        }
    }

    public static class Json
    {
        public static string Quote(string s)
        {
            StringBuilder sb = new StringBuilder("\"");
            foreach (char c in s ?? "")
            {
                switch (c)
                {
                    case '"': sb.Append("\\\""); break;
                    case '\\': sb.Append("\\\\"); break;
                    case '\n': sb.Append("\\n"); break;
                    case '\r': sb.Append("\\r"); break;
                    case '\t': sb.Append("\\t"); break;
                    default:
                        if (c < 0x20 || (c >= 0x7f && c <= 0x9f) || c == (char)0x2028 || c == (char)0x2029)
                            sb.Append("\\u").Append(((int)c).ToString("x4", CultureInfo.InvariantCulture));
                        else sb.Append(c);
                        break;
                }
            }
            return sb.Append('"').ToString();
        }

        public static IDictionary<string, object> ParseObject(string text)
        {
            text = text ?? "";
            if (text.Length > 0 && text[0] == (char)0xfeff) text = text.Substring(1);
            JavaScriptSerializer js = new JavaScriptSerializer();
            js.MaxJsonLength = 4 * 1024 * 1024;
            object o = js.DeserializeObject(text);
            IDictionary<string, object> d = o as IDictionary<string, object>;
            if (d == null) throw new FormatException("not a JSON object");
            return d;
        }

        public static string Str(IDictionary<string, object> d, string key)
        {
            object v;
            if (d == null || !d.TryGetValue(key, out v) || v == null) return null;
            return v as string;
        }

        public static IDictionary<string, object> Obj(IDictionary<string, object> d, string key)
        {
            object v;
            if (d == null || !d.TryGetValue(key, out v)) return null;
            return v as IDictionary<string, object>;
        }

        public static bool? Bool(IDictionary<string, object> d, string key)
        {
            object v;
            if (d == null || !d.TryGetValue(key, out v) || !(v is bool)) return null;
            return (bool)v;
        }

        public static DateTime? Time(IDictionary<string, object> d, string key)
        {
            string s = Str(d, key);
            DateTime t;
            if (s != null && DateTime.TryParse(s, CultureInfo.InvariantCulture, DateTimeStyles.AdjustToUniversal | DateTimeStyles.AssumeUniversal, out t)) return t;
            return null;
        }

        public static string Iso(DateTime utc)
        {
            return utc.ToUniversalTime().ToString("yyyy-MM-dd'T'HH:mm:ss.fff'Z'", CultureInfo.InvariantCulture);
        }
    }

    /** Characters the source never spells out, so the file stays plain ASCII for the C# 5 compiler. */
    public static class Ch
    {
        public static readonly string Dot = " " + (char)0xb7 + " ";
        public static readonly string Tick = new string((char)0x2713, 1);
        public static readonly string Ellipsis = new string((char)0x2026, 1);
        public static readonly string Arrow = new string((char)0x2192, 1);
        public static readonly string Dash = new string((char)0x2014, 1);
        public static readonly string Apos = new string((char)0x2019, 1);
    }

    // -----------------------------------------------------------------------------------------
    // Trusted-site checks. The server is the authority: it checks every entry against the full
    // public suffix list and reports what it refused in status.json. This is a first pass so a
    // typo or an obviously shared address is caught while the person is still typing.
    // -----------------------------------------------------------------------------------------

    public static class Sites
    {
        static readonly Regex Ipv4 = new Regex(@"^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$");
        static readonly Regex HostChars = new Regex(@"^[a-z0-9.-]+$");

        static readonly HashSet<string> Shared = new HashSet<string>(StringComparer.OrdinalIgnoreCase)
        {
            "github.io", "gitlab.io", "bitbucket.io", "herokuapp.com", "herokussl.com", "blogspot.com", "wordpress.com",
            "pages.dev", "workers.dev", "netlify.app", "vercel.app", "web.app", "firebaseapp.com", "appspot.com",
            "azurewebsites.net", "cloudapp.net", "azurestaticapps.net", "cloudfront.net", "amazonaws.com", "s3.amazonaws.com",
            "onrender.com", "fly.dev", "glitch.me", "repl.co", "replit.app", "ngrok.io", "ngrok-free.app", "ngrok.app",
            "duckdns.org", "no-ip.org", "ddns.net", "dyndns.org", "myshopify.com", "wixsite.com", "squarespace.com",
            "tumblr.com", "neocities.org", "surge.sh", "now.sh", "deno.dev", "pythonanywhere.com", "readthedocs.io",
            "co.uk", "org.uk", "ac.uk", "gov.uk", "me.uk", "ltd.uk", "plc.uk", "com.au", "net.au", "org.au", "edu.au",
            "co.nz", "org.nz", "co.jp", "ne.jp", "or.jp", "ac.jp", "com.br", "com.mx", "co.in", "co.za", "com.cn",
            "com.tw", "com.sg", "com.hk", "co.kr", "com.tr", "com.ar", "co.il", "com.my", "co.id", "com.ph", "com.vn"
        };

        public static string HostOf(string raw)
        {
            if (string.IsNullOrWhiteSpace(raw)) return null;
            string text = raw.Trim();
            Uri u;
            if (!Uri.TryCreate(text.Contains("://") ? text : "https://" + text, UriKind.Absolute, out u)) return null;
            if (u.Scheme != Uri.UriSchemeHttp && u.Scheme != Uri.UriSchemeHttps) return null;
            string host;
            try { host = u.IdnHost; } catch { return null; }
            host = (host ?? "").ToLowerInvariant().TrimEnd('.');
            return host.Length == 0 ? null : host;
        }

        /** Returns the host to store, or null with a reason a person can act on. */
        public static string Normalise(string entry, out string reason)
        {
            reason = null;
            string text = (entry ?? "").Trim().ToLowerInvariant();
            if (text.Length == 0) { reason = "Type a site, such as example.com."; return null; }
            if (text.StartsWith("*.")) text = text.Substring(2);
            if (text.StartsWith("[") || text.Count(ch => ch == ':') > 1) { reason = "IPv6 addresses aren't supported."; return null; }
            string host = HostOf(text);
            if (host == null) { reason = "That isn't a web address."; return null; }
            if (host == "localhost" || Ipv4.IsMatch(host)) return host;
            if (!HostChars.IsMatch(host) || host.StartsWith(".") || host.Contains("..")) { reason = "That isn't a valid site name."; return null; }
            if (!host.Contains(".")) { reason = "\"" + host + "\" is a whole top-level domain. Add a specific site."; return null; }
            if (Shared.Contains(host)) { reason = "\"" + host + "\" is shared by many unrelated sites, so it can't be trusted as a whole. Add the specific site instead."; return null; }
            return host;
        }
    }

    // -----------------------------------------------------------------------------------------
    // The vault address. Same rules as validateServerUrl in src/config.ts.
    // -----------------------------------------------------------------------------------------

    public static class VaultUrl
    {
        public const string Us = "https://vault.bitwarden.com";
        public const string Eu = "https://vault.bitwarden.eu";

        static bool Loopback(string host)
        {
            string h = (host ?? "").ToLowerInvariant();
            return h == "localhost" || h == "127.0.0.1" || h == "[::1]" || h == "::1";
        }

        /** The address to store, or null with a reason. A missing scheme means https. */
        public static string Check(string raw, out string error)
        {
            error = null;
            string text = (raw ?? "").Trim();
            if (text.Length == 0) { error = "Enter your server's address, such as https://vault.example.com."; return null; }
            if (!text.Contains("://")) text = "https://" + text;
            Uri u;
            if (!Uri.TryCreate(text, UriKind.Absolute, out u)) { error = "That isn't a valid address. Use the full address, such as https://vault.example.com."; return null; }
            if (u.Scheme != Uri.UriSchemeHttps && u.Scheme != Uri.UriSchemeHttp) { error = "Only http and https addresses work."; return null; }
            if (!string.IsNullOrEmpty(u.UserInfo)) { error = "The address must not contain a user name or password."; return null; }
            if (u.Scheme == Uri.UriSchemeHttp && !Loopback(u.Host))
            {
                error = "Use https. Plain http is only allowed for a server on this computer (localhost).";
                return null;
            }
            string path = u.AbsolutePath.TrimEnd('/');
            string origin = u.Scheme + "://" + u.Authority.ToLowerInvariant();
            return origin + path;
        }

        public static string Host(string url)
        {
            Uri u;
            if (url != null && Uri.TryCreate(url, UriKind.Absolute, out u)) return u.Authority;
            return url;
        }
    }
}
