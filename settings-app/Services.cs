// Bitwarden MCP Settings
// Copyright (C) 2026 ShadowsDistant. Licensed under the GNU GPL v3 or later.
//
// Everything that touches the world outside the window: the files shared with the server, the
// named pipe the server listens on, GitHub for updates, shortcuts, and the activity log.

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.IO.Pipes;
using System.Net;
using System.Reflection;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading.Tasks;
using System.Web.Script.Serialization;

namespace BitwardenMcpSettings
{
    // -----------------------------------------------------------------------------------------
    // status.json, written by the server
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
        public string Install;
        public List<KeyValuePair<string, string>> Rejected = new List<KeyValuePair<string, string>>();
        public IDictionary<string, object> Effective;
        public VaultInfo Vault;
        public string IpcPipe;
        public string IpcToken;
        public string UpdateLatest;
        public string UpdateUrl;
        /** The process named in the file is alive and is the one that wrote it. */
        public bool Running;

        /** Running, and new enough to take requests over the pipe. */
        public bool CanTalk { get { return Running && !string.IsNullOrEmpty(IpcPipe) && !string.IsNullOrEmpty(IpcToken); } }
        public bool IsClaudeDesktop { get { return Install == "claude-desktop"; } }
    }

    public sealed class VaultInfo
    {
        /** no_cli, unconfigured, unauthenticated, locked or unlocked. */
        public string State;
        public string Email;
        public string ServerUrl;
        public string ServerHost;
        public DateTime? LastSync;

        public bool SignedIn { get { return State == "locked" || State == "unlocked"; } }

        public static VaultInfo From(IDictionary<string, object> d)
        {
            if (d == null) return null;
            VaultInfo v = new VaultInfo();
            v.State = Json.Str(d, "state");
            v.Email = Json.Str(d, "email");
            v.ServerUrl = Json.Str(d, "serverUrl");
            v.ServerHost = Json.Str(d, "serverHost");
            if (string.IsNullOrEmpty(v.ServerHost) && !string.IsNullOrEmpty(v.ServerUrl)) v.ServerHost = VaultUrl.Host(v.ServerUrl);
            v.LastSync = Json.Time(d, "lastSync");
            return string.IsNullOrEmpty(v.State) ? null : v;
        }
    }

    // -----------------------------------------------------------------------------------------
    // The files in the home folder
    // -----------------------------------------------------------------------------------------

    public sealed class Store
    {
        public readonly string Home;
        public readonly string SettingsFile;
        public readonly string StatusFile;
        public readonly string ConfigFile;
        public readonly string LaunchFile;
        public readonly string UpdateFile;
        public readonly string LogFile;
        public readonly string ActivityFile;
        public readonly string UpdatesDir;
        public readonly string StableExe;

        public Store(string home)
        {
            Home = home;
            SettingsFile = Path.Combine(home, "settings.json");
            StatusFile = Path.Combine(home, "status.json");
            ConfigFile = Path.Combine(home, "config.json");
            LaunchFile = Path.Combine(home, "launch-request.json");
            UpdateFile = Path.Combine(home, "update.json");
            LogFile = Path.Combine(home, "logs", "server.log");
            ActivityFile = Path.Combine(home, "activity.jsonl");
            UpdatesDir = Path.Combine(home, "updates");
            StableExe = Path.Combine(home, "app", "Bitwarden-MCP-Settings.exe");
        }

        public static string Stamp(string file)
        {
            try
            {
                FileInfo fi = new FileInfo(file);
                return fi.Exists ? fi.LastWriteTimeUtc.Ticks.ToString(CultureInfo.InvariantCulture) + ":" + fi.Length.ToString(CultureInfo.InvariantCulture) : "none";
            }
            catch { return "none"; }
        }

        public string Stamp() { return Stamp(SettingsFile); }

        static string ReadShared(string file)
        {
            using (FileStream fs = new FileStream(file, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete))
            using (StreamReader r = new StreamReader(fs, Encoding.UTF8))
            {
                return r.ReadToEnd();
            }
        }

        /** Whole file to a temporary name, then one rename, so a reader never sees half of it. */
        public static void WriteAtomic(string file, string text)
        {
            Directory.CreateDirectory(Path.GetDirectoryName(file));
            string tmp = file + "." + Process.GetCurrentProcess().Id.ToString(CultureInfo.InvariantCulture) + ".tmp";
            File.WriteAllText(tmp, text, new UTF8Encoding(false));
            if (File.Exists(file))
            {
                try
                {
                    File.Replace(tmp, file, null, true);
                    return;
                }
                catch (IOException) { }
                catch (PlatformNotSupportedException) { }
                File.Copy(tmp, file, true);
                File.Delete(tmp);
                return;
            }
            File.Move(tmp, file);
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
                IDictionary<string, object> d = Json.ParseObject(ReadShared(SettingsFile));
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

        public void Save(SettingsModel m)
        {
            WriteAtomic(SettingsFile, m.ToJson());
        }

        public ServerStatus LoadStatus()
        {
            if (!File.Exists(StatusFile)) return null;
            try
            {
                IDictionary<string, object> d = Json.ParseObject(ReadShared(StatusFile));
                ServerStatus s = new ServerStatus();
                object v;
                s.Version = Json.Str(d, "version");
                if (d.TryGetValue("pid", out v) && v != null && !(v is string) && !(v is bool)) s.Pid = Convert.ToInt32(v, CultureInfo.InvariantCulture);
                s.UpdatedAt = Json.Time(d, "updatedAt");
                s.ServerHost = Json.Str(d, "serverHost");
                bool? b = Json.Bool(d, "cardsEnabled");
                s.CardsEnabled = b.HasValue && b.Value;
                s.CardsSupported = Json.Bool(d, "cardsSupported");
                s.SettingsError = Json.Str(d, "settingsError");
                s.Install = Json.Str(d, "install");
                s.Effective = Json.Obj(d, "effective");
                s.Vault = VaultInfo.From(Json.Obj(d, "vault"));
                IDictionary<string, object> ipc = Json.Obj(d, "ipc");
                s.IpcPipe = Json.Str(ipc, "pipe");
                s.IpcToken = Json.Str(ipc, "token");
                // Only a plain pipe name is accepted: never a path, never another machine.
                if (s.IpcPipe != null && !Regex.IsMatch(s.IpcPipe, @"^[A-Za-z0-9._-]{1,200}$")) s.IpcPipe = null;
                IDictionary<string, object> upd = Json.Obj(d, "update");
                s.UpdateLatest = Json.Str(upd, "latest");
                s.UpdateUrl = Json.Str(upd, "url");
                if (d.TryGetValue("rejectedSites", out v) && v is object[])
                {
                    foreach (object o in (object[])v)
                    {
                        IDictionary<string, object> r = o as IDictionary<string, object>;
                        if (r == null) continue;
                        s.Rejected.Add(new KeyValuePair<string, string>(Convert.ToString(Json.Str(r, "entry")), Convert.ToString(Json.Str(r, "reason"))));
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

        // ---- config.json: where the vault is, and the email to pre-fill ----

        public IDictionary<string, object> LoadConfig()
        {
            try
            {
                if (File.Exists(ConfigFile)) return Json.ParseObject(ReadShared(ConfigFile));
            }
            catch { }
            return new Dictionary<string, object>();
        }

        /** Saves the address and email, keeping anything else already in the file. */
        public void SaveConfig(string serverUrl, string email)
        {
            IDictionary<string, object> d = LoadConfig();
            Dictionary<string, object> next = new Dictionary<string, object>();
            foreach (KeyValuePair<string, object> kv in d) next[kv.Key] = kv.Value;
            if (serverUrl != null) next["serverUrl"] = serverUrl;
            if (email != null)
            {
                if (email.Length == 0) next.Remove("email");
                else next["email"] = email;
            }
            WriteAtomic(ConfigFile, Pretty(next));
        }

        static string Pretty(Dictionary<string, object> d)
        {
            JavaScriptSerializer js = new JavaScriptSerializer();
            StringBuilder sb = new StringBuilder("{");
            bool first = true;
            foreach (KeyValuePair<string, object> kv in d)
            {
                sb.Append(first ? "\n  " : ",\n  ").Append(Json.Quote(kv.Key)).Append(": ").Append(js.Serialize(kv.Value));
                first = false;
            }
            return sb.Append(first ? "}\n" : "\n}\n").ToString();
        }

        // ---- launch-request.json: which page the server asked for ----

        public static readonly string[] Pages = { "welcome", "account", "permissions", "security", "general", "updates", "activity", "about" };

        /** The page asked for, if the request is fresh. The file is removed either way. */
        public string TakeLaunchRequest()
        {
            if (!File.Exists(LaunchFile)) return null;
            string page = null;
            try
            {
                IDictionary<string, object> d = Json.ParseObject(ReadShared(LaunchFile));
                string p = (Json.Str(d, "page") ?? "").Trim().ToLowerInvariant();
                DateTime? at = Json.Time(d, "at");
                bool fresh = at.HasValue && Math.Abs((DateTime.UtcNow - at.Value).TotalMinutes) < 2;
                if (fresh && Array.IndexOf(Pages, p) >= 0) page = p;
            }
            catch { }
            try { File.Delete(LaunchFile); } catch { }
            return page;
        }

        // ---- update.json: the last answer from GitHub, shared with the server ----

        public UpdateInfo LoadUpdateCache()
        {
            try
            {
                if (!File.Exists(UpdateFile)) return null;
                IDictionary<string, object> d = Json.ParseObject(ReadShared(UpdateFile));
                UpdateInfo u = new UpdateInfo();
                u.Latest = Json.Str(d, "latest");
                u.Url = Json.Str(d, "url");
                u.McpbUrl = Json.Str(d, "mcpbUrl");
                u.McpbName = Json.Str(d, "mcpbName");
                u.SumsUrl = Json.Str(d, "sumsUrl");
                DateTime? t = Json.Time(d, "checkedAt");
                u.CheckedAt = t.HasValue ? t.Value : DateTime.MinValue;
                if (!Updater.ValidTag(u.Latest)) return null;
                if (!Updater.TrustedAsset(u.McpbUrl)) { u.McpbUrl = null; u.McpbName = null; }
                if (!Updater.TrustedAsset(u.SumsUrl)) u.SumsUrl = null;
                if (!Updater.TrustedPage(u.Url)) u.Url = Updater.ReleasesPage;
                return u;
            }
            catch
            {
                return null;
            }
        }

        public void SaveUpdateCache(UpdateInfo u)
        {
            Dictionary<string, object> d = new Dictionary<string, object>();
            d["checkedAt"] = Json.Iso(u.CheckedAt);
            d["latest"] = u.Latest;
            d["url"] = u.Url;
            if (u.McpbUrl != null) d["mcpbUrl"] = u.McpbUrl;
            if (u.McpbName != null) d["mcpbName"] = u.McpbName;
            if (u.SumsUrl != null) d["sumsUrl"] = u.SumsUrl;
            try { WriteAtomic(UpdateFile, Pretty(d)); } catch { }
        }
    }

    // -----------------------------------------------------------------------------------------
    // The server's named pipe. One request per connection: a line of JSON out, a line back.
    // -----------------------------------------------------------------------------------------

    public sealed class IpcException : Exception
    {
        public readonly string Kind;
        public IpcException(string kind, string message) : base(message) { Kind = kind; }
    }

    public static class Ipc
    {
        public const int ShortTimeout = 10000;
        public const int LoginTimeout = 120000;

        /**
         * Sends one request. The request may hold a master password: it exists as bytes only for
         * the write, and the buffer is wiped straight after.
         */
        public static IDictionary<string, object> Call(string pipe, string token, Dictionary<string, object> request, int timeoutMs)
        {
            if (string.IsNullOrEmpty(pipe) || string.IsNullOrEmpty(token)) throw new IpcException("unreachable", "The extension isn't running.");
            request["token"] = token;
            byte[] bytes = new UTF8Encoding(false).GetBytes(new JavaScriptSerializer().Serialize(request) + "\n");
            request.Clear();
            try
            {
                using (NamedPipeClientStream p = new NamedPipeClientStream(".", pipe, PipeDirection.InOut, PipeOptions.Asynchronous))
                {
                    try
                    {
                        p.Connect(Math.Min(3000, timeoutMs));
                    }
                    catch (TimeoutException)
                    {
                        throw new IpcException("unreachable", "The extension isn't answering.");
                    }
                    catch (IOException)
                    {
                        throw new IpcException("unreachable", "The extension isn't answering.");
                    }
                    p.Write(bytes, 0, bytes.Length);
                    p.Flush();
                    Array.Clear(bytes, 0, bytes.Length);

                    MemoryStream got = new MemoryStream();
                    byte[] buf = new byte[8192];
                    DateTime deadline = DateTime.UtcNow.AddMilliseconds(timeoutMs);
                    while (true)
                    {
                        int left = (int)(deadline - DateTime.UtcNow).TotalMilliseconds;
                        if (left <= 0) throw new IpcException("timeout", "The extension took too long to answer.");
                        Task<int> t = p.ReadAsync(buf, 0, buf.Length);
                        if (!t.Wait(left)) throw new IpcException("timeout", "The extension took too long to answer.");
                        int n = t.Result;
                        if (n <= 0) break;
                        got.Write(buf, 0, n);
                        if (Array.IndexOf(buf, (byte)'\n', 0, n) >= 0) break;
                        if (got.Length > 1024 * 1024) throw new IpcException("protocol", "The extension sent an answer that was too long.");
                    }
                    string text = Encoding.UTF8.GetString(got.ToArray());
                    int nl = text.IndexOf('\n');
                    if (nl >= 0) text = text.Substring(0, nl);
                    if (text.Trim().Length == 0) throw new IpcException("protocol", "The extension closed the connection without answering.");
                    try
                    {
                        return Json.ParseObject(text);
                    }
                    catch
                    {
                        throw new IpcException("protocol", "The extension sent an answer this app doesn't understand.");
                    }
                }
            }
            catch (AggregateException e)
            {
                throw new IpcException("unreachable", e.InnerException != null ? e.InnerException.Message : e.Message);
            }
            catch (UnauthorizedAccessException e)
            {
                throw new IpcException("unreachable", e.Message);
            }
            finally
            {
                Array.Clear(bytes, 0, bytes.Length);
            }
        }
    }

    // -----------------------------------------------------------------------------------------
    // Updates from GitHub releases
    // -----------------------------------------------------------------------------------------

    public sealed class UpdateInfo
    {
        public string Latest;
        public string Url;
        public string McpbUrl;
        public string McpbName;
        public string SumsUrl;
        public DateTime CheckedAt;
    }

    public static class Updater
    {
        public const string Api = "https://api.github.com/repos/ShadowsDistant/Vaultwarden-MCP/releases/latest";
        public const string AssetPrefix = "https://github.com/ShadowsDistant/Vaultwarden-MCP/releases/download/";
        public const string PagePrefix = "https://github.com/ShadowsDistant/Vaultwarden-MCP/";
        public const string ReleasesPage = "https://github.com/ShadowsDistant/Vaultwarden-MCP/releases/latest";
        static readonly Regex TagRx = new Regex(@"^v?(\d{1,6})\.(\d{1,6})\.(\d{1,6})$");

        public static bool ValidTag(string tag) { return tag != null && TagRx.IsMatch(tag.Trim()); }

        public static bool TrustedAsset(string url)
        {
            return url != null && url.StartsWith(AssetPrefix, StringComparison.Ordinal) && url.IndexOf("..", StringComparison.Ordinal) < 0;
        }

        public static bool TrustedPage(string url)
        {
            return url != null && url.StartsWith(PagePrefix, StringComparison.Ordinal);
        }

        public static string Clean(string tag)
        {
            if (!ValidTag(tag)) return null;
            Match m = TagRx.Match(tag.Trim());
            return int.Parse(m.Groups[1].Value, CultureInfo.InvariantCulture) + "." + int.Parse(m.Groups[2].Value, CultureInfo.InvariantCulture) + "." + int.Parse(m.Groups[3].Value, CultureInfo.InvariantCulture);
        }

        /** Numeric x.y.z comparison. Anything unparseable sorts lowest. */
        public static int Compare(string a, string b)
        {
            int[] x = Parts(a), y = Parts(b);
            for (int i = 0; i < 3; i++) if (x[i] != y[i]) return x[i].CompareTo(y[i]);
            return 0;
        }

        static int[] Parts(string v)
        {
            int[] r = { -1, -1, -1 };
            if (!ValidTag(v)) return r;
            Match m = TagRx.Match(v.Trim());
            for (int i = 0; i < 3; i++) r[i] = int.Parse(m.Groups[i + 1].Value, CultureInfo.InvariantCulture);
            return r;
        }

        public static bool IsNewer(string latest, string current)
        {
            return ValidTag(latest) && Compare(latest, current) > 0;
        }

        /** Reads GitHub's latest-release answer. Returns null when it isn't a usable release. */
        public static UpdateInfo Parse(string json, DateTime now)
        {
            IDictionary<string, object> d = Json.ParseObject(json);
            string tag = Json.Str(d, "tag_name");
            if (!ValidTag(tag)) return null;
            bool? draft = Json.Bool(d, "draft"), pre = Json.Bool(d, "prerelease");
            if ((draft.HasValue && draft.Value) || (pre.HasValue && pre.Value)) return null;
            UpdateInfo u = new UpdateInfo();
            u.Latest = Clean(tag);
            u.CheckedAt = now;
            string page = Json.Str(d, "html_url");
            u.Url = TrustedPage(page) ? page : ReleasesPage;
            object assets;
            if (d.TryGetValue("assets", out assets) && assets is object[])
            {
                foreach (object o in (object[])assets)
                {
                    IDictionary<string, object> a = o as IDictionary<string, object>;
                    string name = Json.Str(a, "name");
                    string url = Json.Str(a, "browser_download_url");
                    if (name == null || !TrustedAsset(url)) continue;
                    if (name.EndsWith(".mcpb", StringComparison.OrdinalIgnoreCase) && Regex.IsMatch(name, @"^[A-Za-z0-9._-]+$"))
                    {
                        u.McpbUrl = url;
                        u.McpbName = name;
                    }
                    else if (name == "SHA256SUMS.txt") u.SumsUrl = url;
                }
            }
            return u;
        }

        static void Prepare()
        {
            try { ServicePointManager.SecurityProtocol |= SecurityProtocolType.Tls12; } catch { }
            // TLS 1.3 is value 12288; the enum member only exists from .NET Framework 4.8.
            try { ServicePointManager.SecurityProtocol |= (SecurityProtocolType)12288; } catch { }
        }

        public static string UserAgent { get { return "Bitwarden-MCP-Settings/" + AppInfo.Version; } }

        public static UpdateInfo Fetch()
        {
            Prepare();
            HttpWebRequest req = (HttpWebRequest)WebRequest.Create(Api);
            req.UserAgent = UserAgent;
            req.Accept = "application/vnd.github+json";
            req.Timeout = 15000;
            req.ReadWriteTimeout = 15000;
            using (HttpWebResponse res = (HttpWebResponse)req.GetResponse())
            using (StreamReader r = new StreamReader(res.GetResponseStream(), Encoding.UTF8))
            {
                return Parse(r.ReadToEnd(), DateTime.UtcNow);
            }
        }

        public static WebClient Client()
        {
            Prepare();
            WebClient wc = new WebClient();
            wc.Headers[HttpRequestHeader.UserAgent] = UserAgent;
            return wc;
        }

        /** name to lower-case hex digest, from a `sha256sum` listing. */
        public static Dictionary<string, string> ParseSums(string text)
        {
            Dictionary<string, string> d = new Dictionary<string, string>(StringComparer.Ordinal);
            foreach (string raw in (text ?? "").Split('\n'))
            {
                Match m = Regex.Match(raw.Trim(), @"^([0-9a-fA-F]{64})\s+\*?(\S+)$");
                if (m.Success) d[m.Groups[2].Value] = m.Groups[1].Value.ToLowerInvariant();
            }
            return d;
        }

        public static string Sha256(string file)
        {
            using (SHA256 h = SHA256.Create())
            using (FileStream fs = File.OpenRead(file))
            {
                byte[] hash = h.ComputeHash(fs);
                StringBuilder sb = new StringBuilder();
                foreach (byte b in hash) sb.Append(b.ToString("x2", CultureInfo.InvariantCulture));
                return sb.ToString();
            }
        }
    }

    // -----------------------------------------------------------------------------------------
    // Shortcuts, through the shell's own COM object so no extra assembly is needed
    // -----------------------------------------------------------------------------------------

    public static class Shortcuts
    {
        public const string FileName = "Bitwarden MCP Settings.lnk";
        public const string LegacyName = "Vaultwarden MCP Settings.lnk";

        /** The copy the server keeps up to date, or this exe when there is none yet. */
        public static string Target(Store store)
        {
            if (File.Exists(store.StableExe)) return store.StableExe;
            return Assembly.GetExecutingAssembly().Location;
        }

        public static string Desktop { get { return Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory); } }
        public static string StartMenu { get { return Environment.GetFolderPath(Environment.SpecialFolder.Programs); } }

        public static string Create(string dir, string target)
        {
            Directory.CreateDirectory(dir);
            string path = Path.Combine(dir, FileName);
            Type t = Type.GetTypeFromProgID("WScript.Shell");
            if (t == null) throw new InvalidOperationException("Windows Script Host isn't available.");
            object shell = Activator.CreateInstance(t);
            try
            {
                object lnk = t.InvokeMember("CreateShortcut", BindingFlags.InvokeMethod, null, shell, new object[] { path });
                Type lt = lnk.GetType();
                lt.InvokeMember("TargetPath", BindingFlags.SetProperty, null, lnk, new object[] { target });
                lt.InvokeMember("WorkingDirectory", BindingFlags.SetProperty, null, lnk, new object[] { Path.GetDirectoryName(target) });
                lt.InvokeMember("IconLocation", BindingFlags.SetProperty, null, lnk, new object[] { target + ",0" });
                lt.InvokeMember("Description", BindingFlags.SetProperty, null, lnk, new object[] { "Choose what your AI assistant may do with your Bitwarden vault" });
                lt.InvokeMember("Save", BindingFlags.InvokeMethod, null, lnk, null);
                System.Runtime.InteropServices.Marshal.FinalReleaseComObject(lnk);
            }
            finally
            {
                System.Runtime.InteropServices.Marshal.FinalReleaseComObject(shell);
            }
            return path;
        }

        /** 0.3.x put "Vaultwarden MCP Settings" on the desktop; the new shortcut replaces it. */
        public static void RemoveLegacy(string dir)
        {
            try
            {
                string old = Path.Combine(dir, LegacyName);
                if (File.Exists(old)) File.Delete(old);
            }
            catch { }
        }
    }

    // -----------------------------------------------------------------------------------------
    // The activity log: the server's audit lines, told as sentences
    // -----------------------------------------------------------------------------------------

    public sealed class ActivityEntry
    {
        public DateTime When;
        public string Event;
        public string Host;
        public string Text;
        public string Glyph;
    }

    public static class Activity
    {
        static readonly Regex Line = new Regex(@"^(\S+)\s+\[audit\]\s+([A-Za-z0-9_.-]+)(.*)$");
        static readonly Regex HostField = new Regex("\"host\"\\s*:\\s*\"([A-Za-z0-9.:\\[\\]-]{1,253})\"");

        public static List<ActivityEntry> Read(string logFile, int max)
        {
            List<ActivityEntry> all = new List<ActivityEntry>();
            if (!File.Exists(logFile)) return all;
            string text;
            using (FileStream fs = new FileStream(logFile, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete))
            {
                // Only the tail matters, and the log can grow.
                long start = Math.Max(0, fs.Length - 2 * 1024 * 1024);
                fs.Seek(start, SeekOrigin.Begin);
                using (StreamReader r = new StreamReader(fs, Encoding.UTF8)) text = r.ReadToEnd();
            }
            foreach (string raw in text.Split('\n'))
            {
                string line = raw.TrimEnd('\r');
                if (line.IndexOf(" [audit] ", StringComparison.Ordinal) < 0) continue;
                Match m = Line.Match(line);
                if (!m.Success) continue;
                DateTime when;
                if (!DateTime.TryParse(m.Groups[1].Value, CultureInfo.InvariantCulture, DateTimeStyles.AdjustToUniversal | DateTimeStyles.AssumeUniversal, out when)) continue;
                ActivityEntry e = new ActivityEntry();
                e.When = when;
                e.Event = m.Groups[2].Value;
                Match h = HostField.Match(m.Groups[3].Value);
                if (h.Success) e.Host = h.Groups[1].Value;
                Describe(e);
                all.Add(e);
            }
            all.Reverse();
            if (all.Count > max) all.RemoveRange(max, all.Count - max);
            return all;
        }

        public static string Humanise(string ev)
        {
            string s = (ev ?? "").Replace('_', ' ').Replace('.', ' ').Trim();
            if (s.Length == 0) return "Something happened";
            return char.ToUpperInvariant(s[0]) + s.Substring(1);
        }

        static void Describe(ActivityEntry e)
        {
            string text;
            string glyph = "E946"; // info
            switch (e.Event)
            {
                case "unlocked": text = "Vault unlocked"; glyph = "E785"; break;
                case "locked": text = "Vault locked"; glyph = "E72E"; break;
                case "idle_lock": text = "Vault locked after a period of inactivity"; glyph = "E72E"; break;
                case "signed_in": text = "Signed in"; glyph = "E77B"; break;
                case "signed_out": text = "Signed out"; glyph = "E77B"; break;
                case "session_rejected_by_cli": text = "Vault locked because it was unlocked or locked elsewhere"; glyph = "E72E"; break;
                case "reauthenticated": text = "Master password confirmed for a protected item"; glyph = "E8D7"; break;
                case "secret_read": text = "A password or code was read"; glyph = "E8D7"; break;
                case "secret_copied": text = "A password or code was copied to the clipboard"; glyph = "E8C8"; break;
                case "secret_allowed": text = "The assistant was allowed a password or code"; glyph = "E8D7"; break;
                case "secret_declined": text = "You declined the assistant's request for a secret"; glyph = "E711"; break;
                case "secret_refused": text = "A request for a secret was refused by your settings"; glyph = "E711"; break;
                case "reveal_to_model": text = "A secret was shared with the assistant"; glyph = "E8D7"; break;
                case "item_created": text = "A new login was saved"; glyph = "E710"; break;
                case "item_edited": text = "An item was changed"; glyph = "E70F"; break;
                case "item_trashed": text = "An item was moved to the trash"; glyph = "E74D"; break;
                case "item_restored": text = "An item was restored from the trash"; glyph = "E777"; break;
                case "settings_in_force": text = "Settings applied"; glyph = "E713"; break;
                case "server_configured": text = "Vault address set"; glyph = "E774"; break;
                case "settings_app_opened": text = "Settings opened from a chat"; glyph = "E713"; break;
                default:
                    if (e.Event.StartsWith("approval_", StringComparison.Ordinal)) { text = "Approval: " + Humanise(e.Event.Substring(9)).ToLowerInvariant(); glyph = "E8D7"; }
                    else text = Humanise(e.Event);
                    break;
            }
            if (!string.IsNullOrEmpty(e.Host) && (e.Event == "unlocked" || e.Event == "signed_in" || e.Event == "server_configured" || e.Event == "reauthenticated"))
            {
                text += " (" + e.Host + ")";
            }
            e.Text = text;
            e.Glyph = glyph;
        }
    }

    // -----------------------------------------------------------------------------------------
    // The activity history: activity.jsonl, one event per line, written by the server. It names
    // items and sites but never usernames, secrets or full addresses.
    // -----------------------------------------------------------------------------------------

    public sealed class HistoryEntry
    {
        public DateTime When;
        /** "secrets", "changes", "account" or "browse". */
        public string Kind;
        public string Title;
        public string Detail;
        public string Glyph;
        /** "Muted", "Danger" or "Success": the glyph's colour. */
        public string Tone = "Muted";
        /** Lower-cased text the search box matches against. */
        public string Search;
    }

    public static class History
    {
        public static bool Exists(Store store) { return File.Exists(store.ActivityFile); }

        public static void Clear(Store store)
        {
            if (File.Exists(store.ActivityFile)) File.Delete(store.ActivityFile);
        }

        public static List<HistoryEntry> Read(Store store, int max)
        {
            List<HistoryEntry> all = new List<HistoryEntry>();
            if (!File.Exists(store.ActivityFile)) return all;
            string text;
            using (FileStream fs = new FileStream(store.ActivityFile, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete))
            {
                long start = Math.Max(0, fs.Length - 3 * 1024 * 1024);
                fs.Seek(start, SeekOrigin.Begin);
                using (StreamReader r = new StreamReader(fs, Encoding.UTF8)) text = r.ReadToEnd();
            }
            JavaScriptSerializer js = new JavaScriptSerializer();
            foreach (string raw in text.Split('\n'))
            {
                string line = raw.Trim();
                if (line.Length < 2 || line[0] != '{') continue;
                IDictionary<string, object> d;
                try { d = js.DeserializeObject(line) as IDictionary<string, object>; }
                catch { continue; }
                if (d == null) continue;
                HistoryEntry e = Describe(d);
                if (e != null) all.Add(e);
            }
            all.Reverse();
            if (all.Count > max) all.RemoveRange(max, all.Count - max);
            return all;
        }

        static string Clip(string s, int n)
        {
            s = (s ?? "").Replace('\r', ' ').Replace('\n', ' ').Trim();
            return s.Length > n ? s.Substring(0, n - 1) + Ch.Ellipsis : s;
        }

        static string FieldWord(string f)
        {
            if (f == "totp") return "one-time code";
            if (f == "notes") return "notes";
            if (f == "password") return "password";
            if (f == "username") return "username";
            return "secret";
        }

        static int? Num(IDictionary<string, object> d, string key)
        {
            object v;
            double n;
            if (d == null || !d.TryGetValue(key, out v) || !SettingsModel.TryNumber(v, out n)) return null;
            return (int)n;
        }

        public static HistoryEntry Describe(IDictionary<string, object> d)
        {
            DateTime? when = Json.Time(d, "at");
            string action = Json.Str(d, "action");
            if (!when.HasValue || string.IsNullOrEmpty(action)) return null;
            string actor = Json.Str(d, "actor") ?? "assistant";
            string app = Clip(Json.Str(d, "app"), 40);
            bool ok = Json.Bool(d, "ok") != false;
            string outcome = Json.Str(d, "outcome");
            string via = Json.Str(d, "via");
            string error = Clip(Json.Str(d, "error"), 160);
            IDictionary<string, object> item = Json.Obj(d, "item");
            string name = Clip(Json.Str(item, "name"), 80);
            string host = Clip(Json.Str(item, "host"), 80);
            string what = name.Length > 0 ? name : "an item";
            string field = FieldWord(Json.Str(d, "field"));

            string who = actor == "you" ? "You" : actor == "settings_app" ? "You" : actor == "system" ? "" : (app.Length > 0 ? app : "Your assistant");
            string whose = actor == "assistant" ? (app.Length > 0 ? app + "'s" : "your assistant's") : "a";

            HistoryEntry e = new HistoryEntry();
            e.When = when.Value;
            e.Kind = "browse";
            e.Glyph = "E946";
            string title;
            List<string> detail = new List<string>();
            if (host.Length > 0) detail.Add(host);

            switch (action)
            {
                case "search":
                    {
                        string q = Clip(Json.Str(d, "query"), 60);
                        title = who + (outcome == "trash" ? " searched the trash" : " searched your vault") + (q.Length > 0 ? " for \"" + q + "\"" : "");
                        int? n = Num(d, "count");
                        if (n.HasValue) detail.Add(n.Value == 1 ? "1 result" : n.Value + " results");
                        e.Glyph = "E721";
                        break;
                    }
                case "view_item":
                    title = who + " looked at " + what;
                    e.Glyph = "E8A1";
                    break;
                case "read_secret":
                case "copy_secret":
                    {
                        e.Kind = "secrets";
                        bool copy = action == "copy_secret";
                        string verb = copy ? "copy" : "read";
                        if (outcome == "declined")
                        {
                            title = "You declined " + whose + " request to " + verb + " the " + field + " for " + what;
                            e.Glyph = "E711";
                            e.Tone = "Danger";
                        }
                        else if (outcome == "refused")
                        {
                            title = who + " asked to " + verb + " the " + field + " for " + what;
                            detail.Add("blocked by your permissions");
                            e.Glyph = "E711";
                            e.Tone = "Danger";
                        }
                        else
                        {
                            title = copy
                                ? who + " copied the " + field + " for " + what + " to your clipboard"
                                : who + " read the " + field + " for " + what;
                            e.Glyph = copy ? "E8C8" : "E7B3";
                            if (via == "trusted_site") detail.Add("allowed because it's a trusted site");
                            else if (via == "session") detail.Add("you approved it earlier this session");
                            else if (via == "dialog") detail.Add("you approved it");
                        }
                        break;
                    }
                case "reveal":
                    e.Kind = "secrets";
                    title = "You showed the " + field + " for " + what;
                    e.Glyph = "E7B3";
                    break;
                case "copy":
                    e.Kind = "secrets";
                    title = outcome == "generated" && name.Length == 0 ? "You copied a generated password" : "You copied the " + field + " for " + what;
                    e.Glyph = "E8C8";
                    break;
                case "generate_password":
                    e.Kind = "changes";
                    title = who + " generated a password";
                    e.Glyph = "E8D7";
                    break;
                case "propose_create":
                    e.Kind = "changes";
                    title = who + " drafted a new login" + (name.Length > 0 ? " for " + name : "");
                    e.Glyph = "E710";
                    break;
                case "propose_edit":
                    {
                        e.Kind = "changes";
                        title = who + " proposed changes to " + what;
                        object fv;
                        if (d.TryGetValue("fields", out fv) && fv is object[] && ((object[])fv).Length > 0)
                        {
                            List<string> fs = new List<string>();
                            foreach (object o in (object[])fv) fs.Add(Clip(Convert.ToString(o, CultureInfo.InvariantCulture), 20));
                            detail.Add("changes " + string.Join(", ", fs.ToArray()));
                        }
                        e.Glyph = "E70F";
                        break;
                    }
                case "propose_trash":
                    e.Kind = "changes";
                    title = who + " asked to move " + what + " to the trash";
                    e.Glyph = "E74D";
                    break;
                case "propose_restore":
                    e.Kind = "changes";
                    title = outcome == "applied" ? who + " restored " + what + " from the trash" : who + " asked to restore " + what + " from the trash";
                    e.Glyph = "E777";
                    break;
                case "apply_change":
                    e.Kind = "changes";
                    e.Tone = "Success";
                    if (outcome == "create") { title = "You saved the new login " + what; e.Glyph = "E710"; }
                    else if (outcome == "trash") { title = "You moved " + what + " to the trash"; e.Glyph = "E74D"; }
                    else if (outcome == "restore") { title = "You restored " + what; e.Glyph = "E777"; }
                    else { title = "You confirmed changes to " + what; e.Glyph = "E70F"; }
                    break;
                case "cancel_change":
                    e.Kind = "changes";
                    title = "You dismissed a proposed change" + (name.Length > 0 ? " to " + name : "");
                    e.Glyph = "E711";
                    break;
                case "sign_in":
                    e.Kind = "account";
                    title = outcome == "opened_settings" ? who + " opened Settings so you could sign in" : who + " signed in";
                    if (via == "api_key") detail.Add("with an API key");
                    e.Glyph = "E77B";
                    break;
                case "unlock": e.Kind = "account"; title = who + " unlocked the vault"; e.Glyph = "E785"; break;
                case "lock": e.Kind = "account"; title = who + " locked the vault"; e.Glyph = "E72E"; break;
                case "sign_out": e.Kind = "account"; title = who + " signed out"; e.Glyph = "E77B"; break;
                case "sync": e.Kind = "account"; title = who + " synced the vault"; e.Glyph = "E895"; break;
                case "idle_lock": e.Kind = "account"; title = "The vault locked itself after a period of inactivity"; e.Glyph = "E72E"; break;
                case "open_settings": e.Kind = "account"; title = who + " opened Bitwarden MCP Settings"; e.Glyph = "E713"; break;
                default:
                    title = (who.Length > 0 ? who + ": " : "") + Activity.Humanise(action).ToLowerInvariant();
                    break;
            }
            if (action.StartsWith("propose_", StringComparison.Ordinal))
            {
                // Without vault cards the change is confirmed in a desktop window right away.
                if (outcome == "confirmed") { detail.Add("you confirmed it"); e.Tone = "Success"; }
                else if (outcome == "declined") detail.Add("you said no");
                else if (outcome == "staged") detail.Add("sent to you to confirm");
            }
            if (actor == "settings_app") detail.Add("in Settings");
            else if (actor == "you") detail.Add("in the vault card");
            if (!ok && outcome != "declined" && outcome != "refused")
            {
                title += " " + Ch.Dash + " it didn't work";
                if (error.Length > 0) detail.Add(error);
                e.Glyph = "E783";
                e.Tone = "Danger";
            }
            e.Title = title.Length > 0 ? char.ToUpperInvariant(title[0]) + title.Substring(1) : title;
            e.Detail = string.Join(Ch.Dot, detail.ToArray());
            e.Search = (e.Title + " " + e.Detail).ToLowerInvariant();
            return e;
        }
    }
}
