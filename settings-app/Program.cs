// Vaultwarden MCP Settings
// Copyright (C) 2026 ShadowsDistant. Licensed under the GNU GPL v3 or later.
//
// A small WPF window that edits settings.json, the file the MCP server re-reads before every
// request. It is deliberately the only thing that writes that file: the server exposes no tool
// that can, so nothing said in a chat can loosen what Claude is allowed to do.
//
// Written to compile with either the Roslyn csc that ships with Visual Studio Build Tools or
// the C# 5 compiler in every .NET Framework 4.x install, so it uses no newer syntax: no string
// interpolation, no ?. operator, no expression-bodied members.

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Input;
using System.Windows.Interop;
using System.Windows.Markup;
using System.Windows.Media;
using System.Windows.Media.Imaging;
using System.Windows.Threading;
using Microsoft.Win32;

[assembly: AssemblyTitle("Vaultwarden MCP Settings")]
[assembly: AssemblyProduct("Vaultwarden MCP")]
[assembly: AssemblyCopyright("Copyright (C) 2026 ShadowsDistant. GPL-3.0-or-later.")]

namespace VaultwardenMcpSettings
{
    // -----------------------------------------------------------------------------------------
    // The settings model. Mirrors src/settings.ts; keep the two in step.
    // -----------------------------------------------------------------------------------------

    public sealed class SettingsModel
    {
        public bool Cards = true;
        public bool AllowChanges = true;
        public string Access = "ask";
        public List<string> TrustedSites = new List<string>();
        public int IdleLockMinutes = 0;
        public int RevealSeconds = 30;
        public int ClipboardClearSeconds = 30;
        /** Keys this version does not know, carried through a save untouched. */
        public Dictionary<string, object> Extra = new Dictionary<string, object>();

        public static readonly string[] Known =
        {
            "cards", "allowChanges", "access", "trustedSites", "idleLockMinutes", "revealSeconds", "clipboardClearSeconds"
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

        static bool TryNumber(object v, out double d)
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

        /** Applies whatever a parsed JSON object holds over these values, key by key. */
        public void Apply(IDictionary<string, object> d, List<string> warnings)
        {
            object v;
            double n;
            if (d.TryGetValue("cards", out v)) { if (v is bool) Cards = (bool)v; else warnings.Add("cards"); }
            if (d.TryGetValue("allowChanges", out v)) { if (v is bool) AllowChanges = (bool)v; else warnings.Add("allowChanges"); }
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
            if (d.TryGetValue("idleLockMinutes", out v)) { if (TryNumber(v, out n)) IdleLockMinutes = Clamp(n, 0, 1440); else warnings.Add("idleLockMinutes"); }
            if (d.TryGetValue("revealSeconds", out v)) { if (TryNumber(v, out n)) RevealSeconds = Clamp(n, 5, 300); else warnings.Add("revealSeconds"); }
            if (d.TryGetValue("clipboardClearSeconds", out v)) { if (TryNumber(v, out n)) ClipboardClearSeconds = Clamp(n, 5, 300); else warnings.Add("clipboardClearSeconds"); }
        }

        public string ToJson()
        {
            StringBuilder sb = new StringBuilder();
            sb.Append("{\n");
            sb.Append("  \"cards\": ").Append(Cards ? "true" : "false").Append(",\n");
            sb.Append("  \"allowChanges\": ").Append(AllowChanges ? "true" : "false").Append(",\n");
            sb.Append("  \"access\": ").Append(Json.Quote(Access)).Append(",\n");
            sb.Append("  \"trustedSites\": [");
            for (int i = 0; i < TrustedSites.Count; i++)
            {
                sb.Append(i == 0 ? "\n    " : ",\n    ").Append(Json.Quote(TrustedSites[i]));
            }
            sb.Append(TrustedSites.Count > 0 ? "\n  ],\n" : "],\n");
            sb.Append("  \"idleLockMinutes\": ").Append(IdleLockMinutes.ToString(CultureInfo.InvariantCulture)).Append(",\n");
            sb.Append("  \"revealSeconds\": ").Append(RevealSeconds.ToString(CultureInfo.InvariantCulture)).Append(",\n");
            sb.Append("  \"clipboardClearSeconds\": ").Append(ClipboardClearSeconds.ToString(CultureInfo.InvariantCulture));
            JavaScriptSerializer js = new JavaScriptSerializer();
            foreach (KeyValuePair<string, object> kv in Extra)
            {
                sb.Append(",\n  ").Append(Json.Quote(kv.Key)).Append(": ").Append(js.Serialize(kv.Value));
            }
            sb.Append("\n}\n");
            return sb.ToString();
        }
    }

    static class Json
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
                        if (c < 0x20 || (c >= 0x7f && c <= 0x9f) || c == '\u2028' || c == '\u2029')
                            sb.Append("\\u").Append(((int)c).ToString("x4", CultureInfo.InvariantCulture));
                        else sb.Append(c);
                        break;
                }
            }
            return sb.Append('"').ToString();
        }

        public static IDictionary<string, object> ParseObject(string text)
        {
            text = (text ?? "").TrimStart('\ufeff');
            JavaScriptSerializer js = new JavaScriptSerializer();
            js.MaxJsonLength = 4 * 1024 * 1024;
            object o = js.DeserializeObject(text);
            IDictionary<string, object> d = o as IDictionary<string, object>;
            if (d == null) throw new FormatException("not a JSON object");
            return d;
        }
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
    // Files
    // -----------------------------------------------------------------------------------------

    public sealed class ServerStatus
    {
        public string Version;
        public int Pid;
        public DateTime? UpdatedAt;
        public string ServerHost;
        public bool CardsEnabled;
        public bool? CardsSupported;
        public string SettingsError;
        public List<KeyValuePair<string, string>> Rejected = new List<KeyValuePair<string, string>>();
        public IDictionary<string, object> Effective;
        public bool Running;
    }

    public sealed class Store
    {
        public readonly string Home;
        public readonly string SettingsFile;
        public readonly string StatusFile;

        public Store(string home)
        {
            Home = home;
            SettingsFile = Path.Combine(home, "settings.json");
            StatusFile = Path.Combine(home, "status.json");
        }

        public string Stamp()
        {
            try
            {
                FileInfo fi = new FileInfo(SettingsFile);
                return fi.Exists ? fi.LastWriteTimeUtc.Ticks.ToString(CultureInfo.InvariantCulture) + ":" + fi.Length.ToString(CultureInfo.InvariantCulture) : "none";
            }
            catch { return "none"; }
        }

        /** Loads settings. `error` is set when a file exists but cannot be used. */
        public SettingsModel Load(ServerStatus status, out string error, out bool fromFile)
        {
            error = null;
            fromFile = false;
            SettingsModel m = new SettingsModel();
            List<string> ignored = new List<string>();
            // With no file yet, start from what the server says is in force, which may have come
            // from environment variables set at install time.
            if (status != null && status.Effective != null) m.Apply(status.Effective, ignored);
            if (!File.Exists(SettingsFile)) return m;
            try
            {
                IDictionary<string, object> d = Json.ParseObject(File.ReadAllText(SettingsFile, Encoding.UTF8));
                m.Apply(d, ignored);
                foreach (KeyValuePair<string, object> kv in d)
                {
                    if (Array.IndexOf(SettingsModel.Known, kv.Key) < 0) m.Extra[kv.Key] = kv.Value;
                }
                fromFile = true;
            }
            catch (Exception e)
            {
                error = e.Message;
            }
            return m;
        }

        /** Whole file to a temporary name, then one rename, so the server never reads half of it. */
        public void Save(SettingsModel m)
        {
            Directory.CreateDirectory(Home);
            string tmp = SettingsFile + "." + Process.GetCurrentProcess().Id.ToString(CultureInfo.InvariantCulture) + ".tmp";
            File.WriteAllText(tmp, m.ToJson(), new UTF8Encoding(false));
            if (File.Exists(SettingsFile))
            {
                try
                {
                    File.Replace(tmp, SettingsFile, null, true);
                    return;
                }
                catch (IOException) { }
                catch (PlatformNotSupportedException) { }
                File.Copy(tmp, SettingsFile, true);
                File.Delete(tmp);
                return;
            }
            File.Move(tmp, SettingsFile);
        }

        public ServerStatus LoadStatus()
        {
            if (!File.Exists(StatusFile)) return null;
            try
            {
                IDictionary<string, object> d = Json.ParseObject(File.ReadAllText(StatusFile, Encoding.UTF8));
                ServerStatus s = new ServerStatus();
                object v;
                if (d.TryGetValue("version", out v)) s.Version = v as string;
                if (d.TryGetValue("pid", out v) && v != null && !(v is string)) s.Pid = Convert.ToInt32(v, CultureInfo.InvariantCulture);
                if (d.TryGetValue("updatedAt", out v) && v is string)
                {
                    DateTime t;
                    if (DateTime.TryParse((string)v, CultureInfo.InvariantCulture, DateTimeStyles.AdjustToUniversal | DateTimeStyles.AssumeUniversal, out t)) s.UpdatedAt = t;
                }
                if (d.TryGetValue("serverHost", out v)) s.ServerHost = v as string;
                if (d.TryGetValue("cardsEnabled", out v) && v is bool) s.CardsEnabled = (bool)v;
                if (d.TryGetValue("cardsSupported", out v) && v is bool) s.CardsSupported = (bool)v;
                if (d.TryGetValue("settingsError", out v)) s.SettingsError = v as string;
                if (d.TryGetValue("effective", out v)) s.Effective = v as IDictionary<string, object>;
                if (d.TryGetValue("rejectedSites", out v) && v is object[])
                {
                    foreach (object o in (object[])v)
                    {
                        IDictionary<string, object> r = o as IDictionary<string, object>;
                        if (r == null) continue;
                        object e, why;
                        r.TryGetValue("entry", out e);
                        r.TryGetValue("reason", out why);
                        s.Rejected.Add(new KeyValuePair<string, string>(Convert.ToString(e), Convert.ToString(why)));
                    }
                }
                s.Running = IsRunning(s);
                return s;
            }
            catch
            {
                return null;
            }
        }

        static bool IsRunning(ServerStatus s)
        {
            if (s.Pid <= 0) return false;
            try
            {
                Process p = Process.GetProcessById(s.Pid);
                if (p.HasExited) return false;
                // A recycled process id belongs to something that started after the server wrote
                // its status, so compare the two clocks.
                if (s.UpdatedAt.HasValue && p.StartTime.ToUniversalTime() > s.UpdatedAt.Value.AddMinutes(1)) return false;
                return true;
            }
            catch
            {
                return false;
            }
        }
    }

    // -----------------------------------------------------------------------------------------
    // Theme
    // -----------------------------------------------------------------------------------------

    static class Theme
    {
        public static bool SystemIsDark()
        {
            try
            {
                object v = Registry.GetValue(@"HKEY_CURRENT_USER\Software\Microsoft\Windows\CurrentVersion\Themes\Personalize", "AppsUseLightTheme", 1);
                return v is int && (int)v == 0;
            }
            catch
            {
                return false;
            }
        }

        static Color C(string hex, byte alpha)
        {
            Color c = (Color)ColorConverter.ConvertFromString(hex);
            c.A = alpha;
            return c;
        }

        static Color C(string hex) { return (Color)ColorConverter.ConvertFromString(hex); }

        // The same palette as the vault card, so the two read as one product.
        public static void Apply(ResourceDictionary r, bool dark)
        {
            Dictionary<string, Color> p = new Dictionary<string, Color>();
            if (dark)
            {
                p["Page"] = C("#1f1f1d");
                p["Surface"] = C("#262624");
                p["Surface2"] = C("#30302e");
                p["Surface3"] = C("#3a3a37");
                p["Fg"] = C("#f5f4ef");
                p["Muted"] = C("#b0aea6");
                p["Faint"] = C("#86847d");
                p["Line"] = C("#373734");
                p["LineStrong"] = C("#4a4945");
                p["Accent"] = C("#6ea8ff");
                p["AccentFg"] = C("#10233f");
                p["AccentSoft"] = C("#6ea8ff", 0x24);
                p["Danger"] = C("#f08b82");
                p["DangerSoft"] = C("#f08b82", 0x22);
                p["Success"] = C("#6bce9c");
                p["SuccessSoft"] = C("#6bce9c", 0x22);
                p["Warn"] = C("#e0b464");
                p["WarnSoft"] = C("#e0b464", 0x1c);
                p["WarnLine"] = C("#e0b464", 0x55);
            }
            else
            {
                p["Page"] = C("#f0eee6");
                p["Surface"] = C("#faf9f5");
                p["Surface2"] = C("#f3f1ea");
                p["Surface3"] = C("#e8e6dc");
                p["Fg"] = C("#141413");
                p["Muted"] = C("#6b6a66");
                p["Faint"] = C("#9b9a94");
                p["Line"] = C("#e3e1d8");
                p["LineStrong"] = C("#cfccc1");
                p["Accent"] = C("#2f6fe0");
                p["AccentFg"] = C("#ffffff");
                p["AccentSoft"] = C("#2f6fe0", 0x14);
                p["Danger"] = C("#b3261e");
                p["DangerSoft"] = C("#b3261e", 0x16);
                p["Success"] = C("#1f7a4d");
                p["SuccessSoft"] = C("#1f7a4d", 0x1a);
                p["Warn"] = C("#9a6212");
                p["WarnSoft"] = C("#e0a040", 0x1f);
                p["WarnLine"] = C("#9a6212", 0x44);
            }
            foreach (KeyValuePair<string, Color> kv in p)
            {
                SolidColorBrush b = new SolidColorBrush(kv.Value);
                b.Freeze();
                r[kv.Key] = b;
            }
        }

        [DllImport("dwmapi.dll")]
        static extern int DwmSetWindowAttribute(IntPtr hwnd, int attr, ref int value, int size);

        public static void TitleBar(Window w, bool dark)
        {
            try
            {
                IntPtr h = new WindowInteropHelper(w).Handle;
                int on = dark ? 1 : 0;
                // 20 is DWMWA_USE_IMMERSIVE_DARK_MODE on Windows 10 2004 and later; 19 before that.
                if (DwmSetWindowAttribute(h, 20, ref on, 4) != 0) DwmSetWindowAttribute(h, 19, ref on, 4);
            }
            catch { }
        }
    }

    // -----------------------------------------------------------------------------------------
    // The window
    // -----------------------------------------------------------------------------------------

    public sealed class MainController
    {
        public readonly Window Window;
        readonly Store store;
        readonly bool dark;

        SettingsModel saved;
        SettingsModel model;
        ServerStatus status;
        string loadError;
        string loadedStamp;
        bool painting;
        bool justSaved;

        static readonly int[] IdleChoices = { 0, 5, 15, 60, 240 };
        static readonly int[] RevealChoices = { 10, 30, 60, 120 };
        static readonly int[] ClipChoices = { 10, 30, 60, 120 };

        T Find<T>(string name) where T : class
        {
            T t = Window.FindName(name) as T;
            if (t == null) throw new InvalidOperationException("The window is missing " + name);
            return t;
        }

        public MainController(string home, string themeOverride)
        {
            store = new Store(home);
            dark = themeOverride == "dark" || (themeOverride != "light" && Theme.SystemIsDark());

            using (Stream s = Assembly.GetExecutingAssembly().GetManifestResourceStream("MainWindow.xaml"))
            {
                Window = (Window)XamlReader.Load(s);
            }
            Theme.Apply(Window.Resources, dark);
            Window.SourceInitialized += delegate { Theme.TitleBar(Window, dark); };

            BitmapSource logo = LoadIcon();
            if (logo != null)
            {
                Find<Image>("Logo").Source = logo;
                Window.Icon = logo;
            }

            BuildPills("IdlePills", "idle", IdleChoices, delegate(int v) { return v == 0 ? "Only when Claude closes" : v < 60 ? v + " min" : (v / 60) + (v == 60 ? " hour" : " hours"); });
            BuildPills("RevealPills", "reveal", RevealChoices, SecondsLabel);
            BuildPills("ClipPills", "clip", ClipChoices, SecondsLabel);
            Wire();
            Reload();
        }

        static string SecondsLabel(int v)
        {
            return v < 60 ? v + " seconds" : v == 60 ? "1 minute" : (v / 60) + " minutes";
        }

        static BitmapSource LoadIcon()
        {
            try
            {
                Stream s = Assembly.GetExecutingAssembly().GetManifestResourceStream("icon.png");
                if (s == null) return null;
                BitmapImage img = new BitmapImage();
                img.BeginInit();
                img.StreamSource = s;
                img.CacheOption = BitmapCacheOption.OnLoad;
                img.EndInit();
                img.Freeze();
                return img;
            }
            catch
            {
                return null;
            }
        }

        delegate string Labeller(int v);

        void BuildPills(string panel, string group, int[] values, Labeller label)
        {
            WrapPanel wp = Find<WrapPanel>(panel);
            Style style = (Style)Window.FindResource("Pill");
            foreach (int v in values)
            {
                RadioButton rb = new RadioButton();
                rb.Style = style;
                rb.GroupName = group;
                rb.Content = label(v);
                rb.Tag = v;
                rb.Checked += delegate { Changed(); };
                wp.Children.Add(rb);
            }
        }

        /** Selects the pill for `value`, adding one for a value set outside this app. */
        void SelectPill(string panel, string group, int value, Labeller label)
        {
            WrapPanel wp = Find<WrapPanel>(panel);
            RadioButton match = null;
            foreach (UIElement c in wp.Children)
            {
                RadioButton rb = c as RadioButton;
                if (rb != null && (int)rb.Tag == value) match = rb;
            }
            if (match == null)
            {
                match = new RadioButton();
                match.Style = (Style)Window.FindResource("Pill");
                match.GroupName = group;
                match.Content = label(value);
                match.Tag = value;
                match.Checked += delegate { Changed(); };
                wp.Children.Add(match);
            }
            match.IsChecked = true;
        }

        int PillValue(string panel, int fallback)
        {
            foreach (UIElement c in Find<WrapPanel>(panel).Children)
            {
                RadioButton rb = c as RadioButton;
                if (rb != null && rb.IsChecked == true) return (int)rb.Tag;
            }
            return fallback;
        }

        void Wire()
        {
            RoutedEventHandler changed = delegate { Changed(); };
            Find<RadioButton>("AccessAsk").Checked += changed;
            Find<RadioButton>("AccessSession").Checked += changed;
            Find<RadioButton>("AccessNever").Checked += changed;
            Find<CheckBox>("Cards").Checked += changed;
            Find<CheckBox>("Cards").Unchecked += changed;
            Find<CheckBox>("AllowChanges").Checked += changed;
            Find<CheckBox>("AllowChanges").Unchecked += changed;

            TextBox input = Find<TextBox>("SiteInput");
            input.TextChanged += delegate
            {
                Find<TextBlock>("SitePlaceholder").Visibility = input.Text.Length == 0 ? Visibility.Visible : Visibility.Collapsed;
                Find<TextBlock>("SiteError").Visibility = Visibility.Collapsed;
            };
            input.KeyDown += delegate(object s, KeyEventArgs e)
            {
                if (e.Key == Key.Enter) { AddSite(); e.Handled = true; }
            };
            Find<Button>("SiteAdd").Click += delegate { AddSite(); };

            Find<Button>("SaveBtn").Click += delegate { Save(); };
            Find<Button>("DiscardBtn").Click += delegate { model = saved.Clone(); Paint(); };
            Find<Button>("ResetDefaults").Click += delegate
            {
                SettingsModel d = new SettingsModel();
                d.Extra = new Dictionary<string, object>(model.Extra);
                model = d;
                Paint();
            };
            Find<Button>("OpenFolder").Click += delegate
            {
                try
                {
                    Directory.CreateDirectory(store.Home);
                    if (File.Exists(store.SettingsFile)) Process.Start("explorer.exe", "/select,\"" + store.SettingsFile + "\"");
                    else Process.Start("explorer.exe", "\"" + store.Home + "\"");
                }
                catch { }
            };
            Find<Button>("OpenHelp").Click += delegate
            {
                try { Process.Start(new ProcessStartInfo("https://github.com/ShadowsDistant/Vaultwarden-MCP#readme") { UseShellExecute = true }); }
                catch { }
            };

            Window.PreviewKeyDown += delegate(object s, KeyEventArgs e)
            {
                if (e.Key == Key.S && (Keyboard.Modifiers & ModifierKeys.Control) != 0) { Save(); e.Handled = true; }
            };

            // Coming back to the window refreshes the server's status, and picks up a settings
            // file changed elsewhere as long as nothing here is unsaved.
            Window.Activated += delegate
            {
                ServerStatus fresh = store.LoadStatus();
                status = fresh;
                if (!Dirty() && store.Stamp() != loadedStamp) Reload();
                else PaintStatus();
            };

            Window.Closing += delegate(object s, System.ComponentModel.CancelEventArgs e)
            {
                if (!Dirty()) return;
                MessageBoxResult r = MessageBox.Show(Window, "Save your changes before closing?", "Vaultwarden MCP Settings", MessageBoxButton.YesNoCancel, MessageBoxImage.Question);
                if (r == MessageBoxResult.Cancel) e.Cancel = true;
                else if (r == MessageBoxResult.Yes && !Save()) e.Cancel = true;
            };
        }

        public void Reload()
        {
            status = store.LoadStatus();
            bool fromFile;
            saved = store.Load(status, out loadError, out fromFile);
            loadedStamp = store.Stamp();
            model = saved.Clone();
            Find<TextBlock>("FilePath").Text = store.SettingsFile;
            Paint();
        }

        void Collect()
        {
            if (painting) return;
            model.Access = Find<RadioButton>("AccessNever").IsChecked == true ? "never" : Find<RadioButton>("AccessSession").IsChecked == true ? "session" : "ask";
            model.Cards = Find<CheckBox>("Cards").IsChecked == true;
            model.AllowChanges = Find<CheckBox>("AllowChanges").IsChecked == true;
            model.IdleLockMinutes = PillValue("IdlePills", model.IdleLockMinutes);
            model.RevealSeconds = PillValue("RevealPills", model.RevealSeconds);
            model.ClipboardClearSeconds = PillValue("ClipPills", model.ClipboardClearSeconds);
        }

        void Changed()
        {
            if (painting) return;
            justSaved = false;
            Collect();
            PaintFooter();
            PaintNotes();
        }

        bool Dirty()
        {
            return model.ToJson() != saved.ToJson();
        }

        void Paint()
        {
            painting = true;
            try
            {
                Find<RadioButton>(model.Access == "never" ? "AccessNever" : model.Access == "session" ? "AccessSession" : "AccessAsk").IsChecked = true;
                Find<CheckBox>("Cards").IsChecked = model.Cards;
                Find<CheckBox>("AllowChanges").IsChecked = model.AllowChanges;
                SelectPill("IdlePills", "idle", model.IdleLockMinutes, delegate(int v) { return v + " min"; });
                SelectPill("RevealPills", "reveal", model.RevealSeconds, SecondsLabel);
                SelectPill("ClipPills", "clip", model.ClipboardClearSeconds, SecondsLabel);
                PaintSites();
            }
            finally
            {
                painting = false;
            }
            PaintStatus();
            PaintFooter();
            PaintNotes();
        }

        void PaintSites()
        {
            StackPanel list = Find<StackPanel>("SiteList");
            list.Children.Clear();
            foreach (string site in model.TrustedSites)
            {
                string entry = site;
                Border row = new Border();
                row.Background = (Brush)Window.FindResource("Surface2");
                row.BorderBrush = (Brush)Window.FindResource("Line");
                row.BorderThickness = new Thickness(1);
                row.CornerRadius = new CornerRadius(8);
                row.Padding = new Thickness(12, 6, 6, 6);
                row.Margin = new Thickness(0, 6, 0, 0);
                Grid g = new Grid();
                g.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
                g.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
                g.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });

                // A site the running server refused gets a warning mark, not a tick: it is on
                // the list but it is not trusted, and the row must not suggest otherwise.
                bool refused = RefusedByServer(entry) != null;
                Border badge = new Border();
                badge.Width = 22;
                badge.Height = 22;
                badge.CornerRadius = new CornerRadius(6);
                badge.Background = (Brush)Window.FindResource(refused ? "DangerSoft" : "SuccessSoft");
                badge.Margin = new Thickness(0, 0, 10, 0);
                TextBlock tick = new TextBlock();
                tick.Text = refused ? "!" : "\u2713";
                tick.FontWeight = FontWeights.Bold;
                tick.Foreground = (Brush)Window.FindResource(refused ? "Danger" : "Success");
                tick.HorizontalAlignment = HorizontalAlignment.Center;
                tick.VerticalAlignment = VerticalAlignment.Center;
                badge.Child = tick;
                g.Children.Add(badge);

                TextBlock t = new TextBlock();
                t.Text = entry;
                t.VerticalAlignment = VerticalAlignment.Center;
                t.TextTrimming = TextTrimming.CharacterEllipsis;
                Grid.SetColumn(t, 1);
                g.Children.Add(t);

                Button remove = new Button();
                remove.Style = (Style)Window.FindResource("SmallBtn");
                remove.Content = "Remove";
                remove.ToolTip = "Stop trusting " + entry;
                remove.Click += delegate
                {
                    model.TrustedSites.Remove(entry);
                    PaintSites();
                    Changed();
                };
                Grid.SetColumn(remove, 2);
                g.Children.Add(remove);
                row.Child = g;
                list.Children.Add(row);
            }
            Find<TextBlock>("SiteEmpty").Visibility = model.TrustedSites.Count == 0 ? Visibility.Visible : Visibility.Collapsed;

            TextBlock rejected = Find<TextBlock>("SiteRejected");
            List<string> lines = new List<string>();
            if (status != null)
            {
                foreach (KeyValuePair<string, string> r in status.Rejected)
                {
                    if (!model.TrustedSites.Contains(r.Key)) continue;
                    // The server's reason usually names the entry already.
                    lines.Add(r.Value.IndexOf(r.Key, StringComparison.OrdinalIgnoreCase) >= 0 ? r.Value : r.Key + ": " + r.Value);
                }
            }
            rejected.Text = lines.Count == 0 ? "" : "The server isn't using these:\n" + string.Join("\n", lines.ToArray());
            rejected.Visibility = lines.Count == 0 ? Visibility.Collapsed : Visibility.Visible;
        }

        void AddSite()
        {
            TextBox input = Find<TextBox>("SiteInput");
            TextBlock err = Find<TextBlock>("SiteError");
            string reason;
            string host = Sites.Normalise(input.Text, out reason);
            if (host == null)
            {
                err.Text = reason;
                err.Visibility = Visibility.Visible;
                return;
            }
            if (model.TrustedSites.Contains(host))
            {
                err.Text = host + " is already on the list.";
                err.Visibility = Visibility.Visible;
                return;
            }
            model.TrustedSites.Add(host);
            input.Text = "";
            PaintSites();
            Changed();
            input.Focus();
        }

        void PaintStatus()
        {
            TextBlock line = Find<TextBlock>("StatusLine");
            TextBlock pill = Find<TextBlock>("StatusPillText");
            Border pillBox = Find<Border>("StatusPill");
            System.Windows.Shapes.Ellipse dot = Find<System.Windows.Shapes.Ellipse>("StatusDot");
            if (status == null)
            {
                line.Text = "The server hasn't run on this computer yet. Add it to Claude, then come back here.";
                pill.Text = "Not set up";
                pillBox.Background = (Brush)Window.FindResource("Surface3");
                dot.Fill = (Brush)Window.FindResource("Faint");
            }
            else
            {
                List<string> bits = new List<string>();
                bits.Add(string.IsNullOrEmpty(status.ServerHost) ? "No vault address set" : status.ServerHost);
                if (!string.IsNullOrEmpty(status.Version)) bits.Add("version " + status.Version);
                if (!status.Running && status.UpdatedAt.HasValue) bits.Add("last ran " + Ago(status.UpdatedAt.Value));
                line.Text = string.Join("  \u00b7  ", bits.ToArray());
                pill.Text = status.Running ? "Running" : "Not running";
                pillBox.Background = (Brush)Window.FindResource(status.Running ? "SuccessSoft" : "Surface3");
                dot.Fill = (Brush)Window.FindResource(status.Running ? "Success" : "Faint");
            }

            Border banner = Find<Border>("Banner");
            TextBlock bannerText = Find<TextBlock>("BannerText");
            if (loadError != null)
            {
                bannerText.Text = "Your settings file couldn't be read (" + loadError + "), so the server is using its strictest settings: no secrets for Claude and no changes. Review the choices below and press Save to fix it.";
                banner.Visibility = Visibility.Visible;
            }
            else if (status != null && !string.IsNullOrEmpty(status.SettingsError) && status.Running)
            {
                bannerText.Text = "The server reported a problem reading your settings, so it is using its strictest settings. Saving here rewrites the file.";
                banner.Visibility = Visibility.Visible;
            }
            else
            {
                banner.Visibility = Visibility.Collapsed;
            }
            PaintNotes();
        }

        void PaintNotes()
        {
            TextBlock note = Find<TextBlock>("CardsNote");
            string text = null;
            if (status != null && status.Running && model.Cards != status.CardsEnabled)
            {
                text = "Restart Claude to " + (model.Cards ? "show" : "hide") + " cards. The rest of these settings apply without a restart.";
            }
            else if (status != null && status.CardsSupported == false && model.Cards)
            {
                text = "The app Claude is running in can't show cards, so it uses plain text either way.";
            }
            note.Text = text ?? "";
            note.Visibility = text == null ? Visibility.Collapsed : Visibility.Visible;
        }

        void PaintFooter()
        {
            bool dirty = Dirty();
            Find<Button>("SaveBtn").IsEnabled = dirty || loadError != null;
            Find<Button>("DiscardBtn").IsEnabled = dirty;
            TextBlock f = Find<TextBlock>("FooterText");
            if (dirty)
            {
                f.Text = "You have unsaved changes.";
                f.Foreground = (Brush)Window.FindResource("Warn");
            }
            else if (justSaved)
            {
                f.Text = "Saved. Claude uses these settings from its next request.";
                f.Foreground = (Brush)Window.FindResource("Success");
            }
            else
            {
                f.Text = "Changes apply to Claude's next request.";
                f.Foreground = (Brush)Window.FindResource("Muted");
            }
        }

        public bool Save()
        {
            Collect();
            try
            {
                store.Save(model);
            }
            catch (Exception e)
            {
                MessageBox.Show(Window, "The settings couldn't be saved.\n\n" + e.Message, "Vaultwarden MCP Settings", MessageBoxButton.OK, MessageBoxImage.Error);
                return false;
            }
            saved = model.Clone();
            loadError = null;
            loadedStamp = store.Stamp();
            justSaved = true;
            PaintStatus();
            PaintFooter();
            return true;
        }

        static string Ago(DateTime utc)
        {
            TimeSpan d = DateTime.UtcNow - utc;
            if (d.TotalMinutes < 1) return "just now";
            if (d.TotalHours < 1) return ((int)d.TotalMinutes) + " min ago";
            if (d.TotalDays < 1) return ((int)d.TotalHours) + (d.TotalHours < 2 ? " hour ago" : " hours ago");
            return ((int)d.TotalDays) + (d.TotalDays < 2 ? " day ago" : " days ago");
        }

        /** Renders the window to a PNG without showing it on screen. Used for docs and checks. */
        string RefusedByServer(string entry)
        {
            if (status == null) return null;
            foreach (KeyValuePair<string, string> r in status.Rejected)
            {
                if (string.Equals(r.Key, entry, StringComparison.OrdinalIgnoreCase)) return r.Value;
            }
            return null;
        }

        public void Screenshot(string file, int height, double scale, double scroll)
        {
            if (height > 0) Window.Height = height;
            if (scroll > 0)
            {
                Window.Loaded += delegate { Find<ScrollViewer>("Scroller").ScrollToVerticalOffset(scroll); };
            }
            Window.WindowStartupLocation = WindowStartupLocation.Manual;
            Window.Left = -30000;
            Window.Top = -30000;
            Window.ShowActivated = false;
            Window.ShowInTaskbar = false;
            Window.ContentRendered += delegate
            {
                Window.Dispatcher.BeginInvoke(DispatcherPriority.ApplicationIdle, new Action(delegate
                {
                    FrameworkElement root = (FrameworkElement)Window.Content;
                    int w = (int)Math.Ceiling(root.ActualWidth * scale);
                    int h = (int)Math.Ceiling(root.ActualHeight * scale);
                    RenderTargetBitmap rtb = new RenderTargetBitmap(w, h, 96 * scale, 96 * scale, PixelFormats.Pbgra32);
                    DrawingVisual bg = new DrawingVisual();
                    using (DrawingContext dc = bg.RenderOpen())
                    {
                        dc.DrawRectangle((Brush)Window.FindResource("Page"), null, new Rect(0, 0, root.ActualWidth, root.ActualHeight));
                    }
                    rtb.Render(bg);
                    rtb.Render(root);
                    PngBitmapEncoder enc = new PngBitmapEncoder();
                    enc.Frames.Add(BitmapFrame.Create(rtb));
                    using (FileStream fs = File.Create(file)) enc.Save(fs);
                    saved = model.Clone();
                    Window.Close();
                }));
            };
        }

        // Hooks for the self-test.
        public SettingsModel Model { get { Collect(); return model; } }
        public void TypeSite(string text) { Find<TextBox>("SiteInput").Text = text; AddSite(); }
        public string SiteError { get { TextBlock t = Find<TextBlock>("SiteError"); return t.Visibility == Visibility.Visible ? t.Text : null; } }
        public void Choose(string radio) { Find<RadioButton>(radio).IsChecked = true; }
        public void Toggle(string box, bool on) { Find<CheckBox>(box).IsChecked = on; }
        public void Pill(string panel, int value) { SelectPill(panel, panel, value, delegate(int v) { return v.ToString(CultureInfo.InvariantCulture); }); }
        public bool IsDirty { get { return Dirty(); } }
        public string BannerShown { get { Border b = Find<Border>("Banner"); return b.Visibility == Visibility.Visible ? Find<TextBlock>("BannerText").Text : null; } }
    }

    // -----------------------------------------------------------------------------------------
    // Self-test: exercises the model, the file handling and the window without showing it.
    // -----------------------------------------------------------------------------------------

    static class SelfTest
    {
        static int failures;

        static void Check(bool ok, string what)
        {
            Console.WriteLine((ok ? "ok    " : "FAIL  ") + what);
            if (!ok) failures++;
        }

        public static int Run()
        {
            string home = Path.Combine(Path.GetTempPath(), "vw-settings-selftest-" + Guid.NewGuid().ToString("N"));
            Directory.CreateDirectory(home);
            try
            {
                string reason;
                Check(Sites.Normalise("https://GitHub.com/login", out reason) == "github.com", "a URL is reduced to its host");
                Check(Sites.Normalise("*.example.org", out reason) == "example.org", "a wildcard prefix is dropped");
                Check(Sites.Normalise("github.io", out reason) == null, "a shared hosting suffix is refused");
                Check(Sites.Normalise("co.uk", out reason) == null, "a public suffix is refused");
                Check(Sites.Normalise("com", out reason) == null, "a top-level domain is refused");
                Check(Sites.Normalise("javascript:alert(1)", out reason) == null, "a script address is refused");
                Check(Sites.Normalise("ftp://example.com", out reason) == null, "a non-web address is refused");
                Check(Sites.Normalise("[::1]", out reason) == null, "IPv6 is refused");
                Check(Sites.Normalise("192.168.1.4", out reason) == "192.168.1.4", "an IPv4 address is kept");
                Check(Sites.Normalise("b\u00fccher.example", out reason) == "xn--bcher-kva.example", "an international name is stored as punycode");

                // A file with unknown keys and odd values.
                File.WriteAllText(Path.Combine(home, "settings.json"),
                    "\ufeff{ \"access\": \"session\", \"trustedSites\": [\"github.com\"], \"idleLockMinutes\": 7.4, \"futureKey\": {\"a\": [1,2]}, \"cards\": \"yes\" }");
                Store store = new Store(home);
                string err;
                bool fromFile;
                SettingsModel m = store.Load(null, out err, out fromFile);
                Check(err == null && fromFile, "a file with a byte-order mark loads");
                Check(m.Access == "session" && m.TrustedSites.Count == 1 && m.IdleLockMinutes == 7, "known values are read and rounded");
                Check(m.Cards, "a value of the wrong type keeps the default");
                Check(m.Extra.ContainsKey("futureKey"), "an unknown key is kept");

                MainController ctl = new MainController(home, "dark");
                Check(ctl.Model.Access == "session", "the window shows the file's access mode");
                Check(!ctl.IsDirty, "a freshly loaded window has nothing to save");
                ctl.TypeSite("gitlab.io");
                Check(ctl.SiteError != null, "the window refuses a shared suffix");
                ctl.TypeSite("https://Vault.Example.com/#/login");
                Check(ctl.Model.TrustedSites.Contains("vault.example.com"), "the window adds a normalised site");
                ctl.Choose("AccessNever");
                ctl.Toggle("AllowChanges", false);
                ctl.Pill("ClipPills", 10);
                Check(ctl.IsDirty, "a change is noticed");
                Check(ctl.Save(), "saving succeeds");
                Check(!ctl.IsDirty, "after saving there is nothing left to save");

                IDictionary<string, object> back = Json.ParseObject(File.ReadAllText(store.SettingsFile));
                Check((string)back["access"] == "never", "the saved file holds the new access mode");
                Check((bool)back["allowChanges"] == false, "the saved file holds the changes switch");
                Check(Convert.ToInt32(back["clipboardClearSeconds"]) == 10, "the saved file holds the clipboard timer");
                Check(((object[])back["trustedSites"]).Length == 2, "the saved file holds both sites");
                Check(back.ContainsKey("futureKey"), "the unknown key survived the save");
                // Bytes, not text: a culture-aware StartsWith treats U+FEFF as ignorable and so
                // reports that every string starts with it.
                Check(File.ReadAllBytes(store.SettingsFile)[0] == (byte)'{', "the saved file has no byte-order mark");
                Check(Directory.GetFiles(home, "*.tmp").Length == 0, "no temporary file is left behind");

                File.WriteAllText(store.SettingsFile, "{ \"access\": ");
                MainController broken = new MainController(home, "light");
                Check(broken.BannerShown != null, "an unreadable file is explained");
                Check(broken.Model.Access == "ask", "an unreadable file shows the defaults rather than guessing");

                File.WriteAllText(store.StatusFile, "{\"version\":\"9.9.9\",\"pid\":1,\"serverHost\":\"vault.example.com\",\"cardsEnabled\":true,\"rejectedSites\":[{\"entry\":\"x.y\",\"reason\":\"nope\"}],\"effective\":{\"access\":\"never\",\"idleLockMinutes\":15}}");
                File.Delete(store.SettingsFile);
                ServerStatus st = store.LoadStatus();
                Check(st != null && st.ServerHost == "vault.example.com" && st.Rejected.Count == 1, "the status file is read");
                SettingsModel fromStatus = store.Load(st, out err, out fromFile);
                Check(!fromFile && fromStatus.Access == "never" && fromStatus.IdleLockMinutes == 15, "with no file, the server's settings in force are the starting point");
            }
            catch (Exception e)
            {
                Check(false, "unexpected: " + e);
            }
            finally
            {
                try { Directory.Delete(home, true); } catch { }
            }
            Console.WriteLine(failures == 0 ? "selftest passed" : failures + " selftest check(s) failed");
            return failures == 0 ? 0 : 1;
        }
    }

    static class Program
    {
        [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr h);
        [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr h, int cmd);

        [STAThread]
        static int Main(string[] args)
        {
            string home = null, shot = null, theme = null;
            bool selftest = false;
            int height = 0;
            double scale = 1, scroll = 0;
            for (int i = 0; i < args.Length; i++)
            {
                string a = args[i];
                string next = i + 1 < args.Length ? args[i + 1] : null;
                if (a == "--home" && next != null) { home = next; i++; }
                else if (a == "--screenshot" && next != null) { shot = next; i++; }
                else if (a == "--theme" && next != null) { theme = next; i++; }
                else if (a == "--height" && next != null) { int.TryParse(next, out height); i++; }
                else if (a == "--scale" && next != null) { double.TryParse(next, NumberStyles.Float, CultureInfo.InvariantCulture, out scale); i++; }
                else if (a == "--scroll" && next != null) { double.TryParse(next, NumberStyles.Float, CultureInfo.InvariantCulture, out scroll); i++; }
                else if (a == "--selftest") selftest = true;
            }
            if (string.IsNullOrEmpty(home)) home = Environment.GetEnvironmentVariable("VW_MCP_HOME");
            if (string.IsNullOrEmpty(home)) home = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ".vaultwarden-mcp");
            home = Path.GetFullPath(home);

            if (selftest)
            {
                Application testApp = new Application();
                testApp.ShutdownMode = ShutdownMode.OnExplicitShutdown;
                return SelfTest.Run();
            }

            Mutex single = null;
            if (shot == null)
            {
                bool created;
                single = new Mutex(true, "Local\\VaultwardenMcpSettings", out created);
                if (!created)
                {
                    // Already open: bring that window forward instead of opening a second editor
                    // that could overwrite the first one's save.
                    Process me = Process.GetCurrentProcess();
                    foreach (Process p in Process.GetProcessesByName(me.ProcessName))
                    {
                        if (p.Id != me.Id && p.MainWindowHandle != IntPtr.Zero)
                        {
                            ShowWindow(p.MainWindowHandle, 9);
                            SetForegroundWindow(p.MainWindowHandle);
                        }
                    }
                    return 0;
                }
            }

            Application app = new Application();
            app.ShutdownMode = ShutdownMode.OnMainWindowClose;
            MainController ctl = new MainController(home, theme);
            if (shot != null) ctl.Screenshot(Path.GetFullPath(shot), height, scale, scroll);
            int code = app.Run(ctl.Window);
            GC.KeepAlive(single);
            return code;
        }
    }
}
