// Bitwarden MCP Settings
// Copyright (C) 2026 ShadowsDistant. Licensed under the GNU GPL v3 or later.
//
// The self-test: the model, the files, the pipe protocol against a stand-in server, and the
// window itself, rendered off-screen in both themes with every page checked for contrast.

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.IO.Pipes;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows;
using System.Windows.Threading;

namespace BitwardenMcpSettings
{
    static class SelfTest
    {
        static int failures;
        static int checks;

        static void Check(bool ok, string what)
        {
            checks++;
            Console.WriteLine((ok ? "ok    " : "FAIL  ") + what);
            if (!ok) failures++;
        }

        static void Pump(int ms)
        {
            DispatcherFrame f = new DispatcherFrame();
            DispatcherTimer t = new DispatcherTimer(DispatcherPriority.Background);
            t.Interval = TimeSpan.FromMilliseconds(ms);
            t.Tick += delegate { t.Stop(); f.Continue = false; };
            t.Start();
            Dispatcher.PushFrame(f);
        }

        static bool PumpUntil(Func<bool> done, int ms)
        {
            DateTime end = DateTime.UtcNow.AddMilliseconds(ms);
            while (DateTime.UtcNow < end)
            {
                if (done()) return true;
                Pump(25);
            }
            return done();
        }

        public static int Run()
        {
            // Awaits in the window resume on this thread, as they do under Application.Run.
            SynchronizationContext.SetSynchronizationContext(new DispatcherSynchronizationContext(Dispatcher.CurrentDispatcher));
            string home = Path.Combine(Path.GetTempPath(), "bw-settings-selftest-" + Guid.NewGuid().ToString("N"));
            Directory.CreateDirectory(home);
            try
            {
                Model();
                Urls();
                Updates(home);
                Files(home);
                ActivityLog(home);
                ShortcutFile(home);
                Window(home);
                Pipe(home);
                Contrast(home);
            }
            catch (Exception e)
            {
                Check(false, "unexpected: " + e);
            }
            finally
            {
                try { Directory.Delete(home, true); } catch { }
            }
            Console.WriteLine(failures == 0 ? "selftest passed (" + checks + " checks)" : failures + " of " + checks + " selftest check(s) failed");
            return failures == 0 ? 0 : 1;
        }

        static void Model()
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
            Check(Sites.Normalise("b" + (char)0xfc + "cher.example", out reason) == "xn--bcher-kva.example", "an international name is stored as punycode");

            List<string> w = new List<string>();
            SettingsModel old = new SettingsModel();
            old.Apply(Json.ParseObject("{\"idleLockMinutes\": 7.4}"), w);
            Check(old.LockMode == "idle" && old.IdleLockMinutes == 7, "an old file with an idle timer means lock when idle");
            SettingsModel old0 = new SettingsModel();
            old0.Apply(Json.ParseObject("{\"idleLockMinutes\": 0}"), w);
            Check(old0.LockMode == "exit" && old0.IdleLockMinutes == 15, "an old file with no idle timer means lock when the app closes");
            SettingsModel bad = new SettingsModel();
            w.Clear();
            bad.Apply(Json.ParseObject("{\"lockMode\": \"sometimes\", \"theme\": 3, \"animations\": \"loud\"}"), w);
            Check(bad.LockMode == "exit" && bad.Theme == "system" && bad.Animations == "on" && w.Count == 3, "unknown values keep the defaults and are reported");

            SettingsModel m = new SettingsModel();
            m.LockMode = "never";
            m.AllowTrash = false;
            m.UpdateCheck = false;
            m.Theme = "dark";
            m.Animations = "off";
            m.IdleLockMinutes = 30;
            SettingsModel back = new SettingsModel();
            back.Apply(Json.ParseObject(m.ToJson()), w);
            Check(back.LockMode == "never" && !back.AllowTrash && !back.UpdateCheck && back.Theme == "dark" && back.Animations == "off" && back.IdleLockMinutes == 30, "every new setting survives a round trip");
            SettingsModel d = new SettingsModel();
            Check(d.Animations == "on" && d.LockMode == "exit" && d.AllowTrash && d.UpdateCheck, "the defaults are as documented");
        }

        static void Urls()
        {
            string err;
            Check(VaultUrl.Check("vault.example.com/", out err) == "https://vault.example.com", "a bare host becomes an https address");
            Check(VaultUrl.Check("https://Vault.Example.com/vault/", out err) == "https://vault.example.com/vault", "a path is kept and the trailing slash dropped");
            Check(VaultUrl.Check("http://vault.example.com", out err) == null, "plain http is refused for a remote server");
            Check(VaultUrl.Check("http://localhost:8080", out err) == "http://localhost:8080", "plain http is allowed for localhost");
            Check(VaultUrl.Check("https://me:pw@vault.example.com", out err) == null, "an address with credentials is refused");
            Check(VaultUrl.Check("ftp://vault.example.com", out err) == null, "a non-web address is refused");
            Check(VaultUrl.Check("", out err) == null && err != null, "an empty address is explained");
        }

        static void Updates(string home)
        {
            Check(Updater.IsNewer("0.4.1", "0.4.0") && Updater.IsNewer("v0.10.0", "0.9.9") && !Updater.IsNewer("0.4.0", "0.4.0") && !Updater.IsNewer("0.3.9", "0.4.0"), "versions compare numerically");
            Check(Updater.ValidTag("v1.2.3") && !Updater.ValidTag("1.2") && !Updater.ValidTag("1.2.3-beta") && !Updater.ValidTag("<b>1.2.3</b>"), "only plain x.y.z tags are accepted");
            string good = "{\"tag_name\":\"v0.5.0\",\"draft\":false,\"prerelease\":false,\"html_url\":\"https://github.com/ShadowsDistant/Vaultwarden-MCP/releases/tag/v0.5.0\",\"assets\":[" +
                "{\"name\":\"vaultwarden-mcp-0.5.0.mcpb\",\"browser_download_url\":\"https://github.com/ShadowsDistant/Vaultwarden-MCP/releases/download/v0.5.0/vaultwarden-mcp-0.5.0.mcpb\"}," +
                "{\"name\":\"SHA256SUMS.txt\",\"browser_download_url\":\"https://github.com/ShadowsDistant/Vaultwarden-MCP/releases/download/v0.5.0/SHA256SUMS.txt\"}," +
                "{\"name\":\"evil.mcpb\",\"browser_download_url\":\"https://evil.example/evil.mcpb\"}]}";
            UpdateInfo u = Updater.Parse(good, DateTime.UtcNow);
            Check(u != null && u.Latest == "0.5.0" && u.McpbName == "vaultwarden-mcp-0.5.0.mcpb" && u.SumsUrl != null, "a release is read with its bundle and checksums");
            Check(u != null && Updater.TrustedAsset(u.McpbUrl), "an asset from anywhere else is ignored");
            Check(Updater.Parse("{\"tag_name\":\"v0.5.0\",\"prerelease\":true}", DateTime.UtcNow) == null, "a pre-release is not offered");
            Check(Updater.Parse("{\"tag_name\":\"latest\"}", DateTime.UtcNow) == null, "a release with an odd tag is not offered");
            Dictionary<string, string> sums = Updater.ParseSums("ABCDEF0123456789abcdef0123456789abcdef0123456789abcdef0123456789  a.mcpb\nnonsense\n");
            Check(sums.Count == 1 && sums["a.mcpb"] == "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789", "a checksum list is read");

            Store store = new Store(home);
            store.SaveUpdateCache(u);
            UpdateInfo again = store.LoadUpdateCache();
            Check(again != null && again.Latest == "0.5.0" && again.McpbUrl == u.McpbUrl, "the update cache round-trips");
            File.WriteAllText(store.UpdateFile, "{\"latest\":\"9.9.9\",\"url\":\"https://evil.example\",\"mcpbUrl\":\"https://evil.example/x.mcpb\",\"checkedAt\":\"2026-01-01T00:00:00Z\"}");
            UpdateInfo tampered = store.LoadUpdateCache();
            Check(tampered != null && tampered.McpbUrl == null && tampered.Url == Updater.ReleasesPage, "a cache pointing anywhere but the project's releases is not trusted");
            File.Delete(store.UpdateFile);
        }

        static void Files(string home)
        {
            Store store = new Store(home);
            File.WriteAllText(store.ConfigFile, "{\"serverUrl\":\"https://old.example\",\"keep\":1}");
            store.SaveConfig("https://vault.example.com", "me@example.com");
            IDictionary<string, object> cfg = store.LoadConfig();
            Check(Json.Str(cfg, "serverUrl") == "https://vault.example.com" && Json.Str(cfg, "email") == "me@example.com" && cfg.ContainsKey("keep"), "the config file keeps keys it doesn't own");
            Check(File.ReadAllBytes(store.ConfigFile)[0] == (byte)'{', "the config file has no byte-order mark");

            File.WriteAllText(store.LaunchFile, "{\"page\":\"updates\",\"at\":\"" + Json.Iso(DateTime.UtcNow) + "\"}");
            Check(store.TakeLaunchRequest() == "updates" && !File.Exists(store.LaunchFile), "a fresh launch request opens its page and is removed");
            File.WriteAllText(store.LaunchFile, "{\"page\":\"updates\",\"at\":\"2020-01-01T00:00:00Z\"}");
            Check(store.TakeLaunchRequest() == null && !File.Exists(store.LaunchFile), "a stale launch request is ignored and removed");
            File.WriteAllText(store.LaunchFile, "{\"page\":\"C:\\\\Windows\",\"at\":\"" + Json.Iso(DateTime.UtcNow) + "\"}");
            Check(store.TakeLaunchRequest() == null, "a launch request for an unknown page is ignored");

            File.WriteAllText(store.StatusFile, "{\"version\":\"0.4.0\",\"pid\":" + Process.GetCurrentProcess().Id + ",\"updatedAt\":\"" + Json.Iso(DateTime.UtcNow) + "\",\"install\":\"claude-desktop\"," +
                "\"vault\":{\"state\":\"locked\",\"email\":\"me@example.com\",\"serverUrl\":\"https://vault.example.com\"},\"ipc\":{\"pipe\":\"bitwarden-mcp-1-ab\",\"token\":\"00ff\"},\"update\":{\"latest\":\"0.5.0\"}}");
            ServerStatus st = store.LoadStatus();
            Check(st != null && st.Running && st.CanTalk && st.IsClaudeDesktop && st.Vault != null && st.Vault.State == "locked" && st.Vault.ServerHost == "vault.example.com" && st.UpdateLatest == "0.5.0", "the new status fields are read");
            File.WriteAllText(store.StatusFile, "{\"version\":\"0.4.0\",\"pid\":" + Process.GetCurrentProcess().Id + ",\"ipc\":{\"pipe\":\"..\\\\..\\\\x\",\"token\":\"00ff\"}}");
            ServerStatus st2 = store.LoadStatus();
            Check(st2 != null && !st2.CanTalk, "a pipe name that looks like a path is refused");
            File.Delete(store.StatusFile);
            File.Delete(store.ConfigFile);
        }

        static void ActivityLog(string home)
        {
            Store store = new Store(home);
            Directory.CreateDirectory(Path.GetDirectoryName(store.LogFile));
            File.WriteAllText(store.LogFile,
                "2026-11-17T06:45:38.295Z [audit] settings_in_force {\"summary\":\"access=ask\"}\n" +
                "2026-11-17T06:45:39.000Z [info] not audit\n" +
                "2026-11-17T07:00:00.000Z [audit] unlocked {\"host\":\"vault.example.com\",\"secret\":\"no\"}\n" +
                "2026-11-17T07:01:00.000Z [audit] brand_new_event {}\n");
            List<ActivityEntry> a = Activity.Read(store.LogFile, 300);
            Check(a.Count == 3 && a[0].Event == "brand_new_event" && a[2].Event == "settings_in_force", "audit lines are read newest first, other lines skipped");
            Check(a.Count == 3 && a[1].Text == "Vault unlocked (vault.example.com)" && a[1].Text.IndexOf("secret", StringComparison.Ordinal) < 0, "only the event and its host are shown");
            Check(a.Count == 3 && a[0].Text == "Brand new event", "an unknown event is shown in words");

            // activity.jsonl, the detailed history.
            File.WriteAllText(store.ActivityFile,
                "{\"v\":1,\"at\":\"2026-11-17T08:00:00.000Z\",\"actor\":\"assistant\",\"app\":\"Claude\",\"action\":\"search\",\"ok\":true,\"query\":\"git\",\"count\":2}\n" +
                "not json\n" +
                "{\"v\":1,\"at\":\"2026-11-17T08:00:05.000Z\",\"actor\":\"assistant\",\"app\":\"Claude\",\"action\":\"copy_secret\",\"ok\":true,\"item\":{\"id\":\"x\",\"name\":\"GitHub\",\"host\":\"github.com\"},\"field\":\"password\",\"outcome\":\"allowed\",\"via\":\"trusted_site\"}\n" +
                "{\"v\":1,\"at\":\"2026-11-17T08:00:09.000Z\",\"actor\":\"assistant\",\"app\":\"Cursor\",\"action\":\"read_secret\",\"ok\":false,\"item\":{\"id\":\"y\",\"name\":\"Bank\"},\"field\":\"totp\",\"outcome\":\"declined\",\"error\":\"The user declined.\"}\n" +
                "{\"v\":1,\"at\":\"2026-11-17T08:01:00.000Z\",\"actor\":\"you\",\"action\":\"apply_change\",\"ok\":true,\"item\":{\"id\":\"x\",\"name\":\"GitHub\"},\"outcome\":\"edit\"}\n" +
                "{\"v\":1,\"at\":\"2026-11-17T08:02:00.000Z\",\"actor\":\"settings_app\",\"action\":\"unlock\",\"ok\":false,\"error\":\"That master password didn't unlock your vault.\"}\n" +
                "{\"v\":1,\"at\":\"2026-11-17T08:03:00.000Z\",\"action\":\"future_thing\",\"ok\":true}\n");
            List<HistoryEntry> h = History.Read(store, 100);
            Check(h.Count == 6 && h[5].Title == "Claude searched your vault for \"git\"" && h[5].Detail == "2 results", "a search reads as a sentence, newest first, bad lines skipped");
            Check(h.Count == 6 && h[4].Title == "Claude copied the password for GitHub to your clipboard" && h[4].Kind == "secrets" && h[4].Detail.Contains("trusted site") && h[4].Detail.Contains("github.com"), "a copied password names the app, the item, the site and why it was allowed");
            Check(h.Count == 6 && h[3].Title.StartsWith("You declined Cursor's request to read the one-time code for Bank", StringComparison.Ordinal) && h[3].Tone == "Danger", "a declined request says so");
            Check(h.Count == 6 && h[2].Title == "You confirmed changes to GitHub" && h[2].Kind == "changes", "a confirmed change is the user's");
            Check(h.Count == 6 && h[1].Kind == "account" && h[1].Detail.Contains("didn't unlock") && h[1].Detail.Contains("in Settings"), "a failed unlock in Settings shows the reason");
            Check(h.Count == 6 && h[0].Title.Length > 0, "an unknown action still shows");
            History.Clear(store);
            Check(!History.Exists(store) && History.Read(store, 10).Count == 0, "clearing removes the history");
        }

        static void ShortcutFile(string home)
        {
            string dir = Path.Combine(home, "shortcuts");
            try
            {
                string path = Shortcuts.Create(dir, Process.GetCurrentProcess().MainModule.FileName);
                File.WriteAllText(Path.Combine(dir, Shortcuts.LegacyName), "x");
                Shortcuts.RemoveLegacy(dir);
                Check(File.Exists(path) && !File.Exists(Path.Combine(dir, Shortcuts.LegacyName)), "a shortcut is created and the old one removed");
            }
            catch (Exception e)
            {
                Check(false, "a shortcut can be created (" + e.Message + ")");
            }
        }

        static void Window(string home)
        {
            Store store = new Store(home);
            File.WriteAllText(store.SettingsFile,
                (char)0xfeff + "{ \"access\": \"session\", \"trustedSites\": [\"github.com\"], \"idleLockMinutes\": 7.4, \"futureKey\": {\"a\": [1,2]}, \"cards\": \"yes\" }");
            string err;
            bool fromFile;
            SettingsModel m = store.Load(null, out err, out fromFile);
            Check(err == null && fromFile, "a file with a byte-order mark loads");
            Check(m.Access == "session" && m.TrustedSites.Count == 1 && m.IdleLockMinutes == 7 && m.LockMode == "idle", "known values are read and rounded");
            Check(m.Cards, "a value of the wrong type keeps the default");
            Check(m.Extra.ContainsKey("futureKey"), "an unknown key is kept");

            MainController ctl = new MainController(home, "dark", true);
            Check(ctl.Model.Access == "session", "the window shows the file's access mode");
            Check(!ctl.IsDirty, "a freshly loaded window has nothing to save");
            ctl.TypeSite("gitlab.io");
            Check(ctl.SiteError != null, "the window refuses a shared suffix");
            ctl.TypeSite("https://Vault.Example.com/#/login");
            Check(ctl.Model.TrustedSites.Contains("vault.example.com"), "the window adds a normalised site");
            ctl.Choose("AccessNever");
            ctl.Toggle("AllowChanges", false);
            Check(!ctl.IsEnabled("AllowTrash"), "the trash switch is disabled while changes are off");
            ctl.Pill("ClipPills", 10);
            ctl.Choose("LockNever");
            Check(ctl.IsShown("NeverWarning"), "choosing never shows the warning");
            ctl.Toggle("UpdateCheck", false);
            Check(ctl.IsDirty, "a change is noticed");
            Check(ctl.Save(), "saving succeeds");
            Check(!ctl.IsDirty, "after saving there is nothing left to save");

            IDictionary<string, object> back = Json.ParseObject(File.ReadAllText(store.SettingsFile));
            Check((string)back["access"] == "never", "the saved file holds the new access mode");
            Check((bool)back["allowChanges"] == false, "the saved file holds the changes switch");
            Check((string)back["lockMode"] == "never" && Convert.ToInt32(back["idleLockMinutes"]) == 7, "the saved file holds the lock choice and keeps the idle timer");
            Check((bool)back["updateCheck"] == false, "the saved file holds the update switch");
            Check(Convert.ToInt32(back["clipboardClearSeconds"]) == 10, "the saved file holds the clipboard timer");
            Check(((object[])back["trustedSites"]).Length == 2, "the saved file holds both sites");
            Check(back.ContainsKey("futureKey"), "the unknown key survived the save");
            // Bytes, not text: a culture-aware StartsWith treats U+FEFF as ignorable and so
            // reports that every string starts with it.
            Check(File.ReadAllBytes(store.SettingsFile)[0] == (byte)'{', "the saved file has no byte-order mark");
            Check(Directory.GetFiles(home, "*.tmp").Length == 0, "no temporary file is left behind");
            ctl.Window.Close();

            File.WriteAllText(store.SettingsFile, "{ \"access\": ");
            MainController broken = new MainController(home, "light", true);
            Check(broken.BannerShown != null, "an unreadable file is explained");
            Check(broken.Model.Access == "ask", "an unreadable file shows the defaults rather than guessing");
            broken.Window.Close();

            File.WriteAllText(store.StatusFile, "{\"version\":\"9.9.9\",\"pid\":1,\"serverHost\":\"vault.example.com\",\"cardsEnabled\":true,\"rejectedSites\":[{\"entry\":\"x.y\",\"reason\":\"nope\"}],\"effective\":{\"access\":\"never\",\"idleLockMinutes\":15}}");
            File.Delete(store.SettingsFile);
            ServerStatus st = store.LoadStatus();
            Check(st != null && st.ServerHost == "vault.example.com" && st.Rejected.Count == 1, "the status file is read");
            SettingsModel fromStatus = store.Load(st, out err, out fromFile);
            Check(!fromFile && fromStatus.Access == "never" && fromStatus.LockMode == "idle" && fromStatus.IdleLockMinutes == 15, "with no file, the server's settings in force are the starting point");
            File.Delete(store.StatusFile);
        }

        // ---- a stand-in for the server's pipe ----

        sealed class FakeServer
        {
            public string Pipe = "bitwarden-mcp-selftest-" + Guid.NewGuid().ToString("N").Substring(0, 12);
            public string Token = Guid.NewGuid().ToString("N") + Guid.NewGuid().ToString("N");
            public string State = "unauthenticated";
            public List<IDictionary<string, object>> Seen = new List<IDictionary<string, object>>();
            public bool BadToken;
            volatile bool stop;

            public void Start()
            {
                Thread t = new Thread(Loop);
                t.IsBackground = true;
                t.Start();
            }

            public void Stop() { stop = true; }

            void Loop()
            {
                while (!stop)
                {
                    try
                    {
                        using (NamedPipeServerStream s = new NamedPipeServerStream(Pipe, PipeDirection.InOut, 1))
                        {
                            s.WaitForConnection();
                            StringBuilder sb = new StringBuilder();
                            byte[] buf = new byte[4096];
                            while (true)
                            {
                                int n = s.Read(buf, 0, buf.Length);
                                if (n <= 0) break;
                                sb.Append(Encoding.UTF8.GetString(buf, 0, n));
                                if (sb.ToString().IndexOf('\n') >= 0) break;
                            }
                            IDictionary<string, object> req = Json.ParseObject(sb.ToString().Split('\n')[0]);
                            lock (Seen) Seen.Add(req);
                            string reply = Answer(req);
                            byte[] outb = Encoding.UTF8.GetBytes(reply + "\n");
                            s.Write(outb, 0, outb.Length);
                            s.Flush();
                            s.WaitForPipeDrain();
                        }
                    }
                    catch { if (stop) return; }
                }
            }

            string Answer(IDictionary<string, object> req)
            {
                if (Json.Str(req, "token") != Token) { BadToken = true; return "{\"ok\":false,\"error\":\"unknown\"}"; }
                string op = Json.Str(req, "op");
                if (op == "status") return "{\"ok\":true,\"state\":\"" + State + "\",\"email\":\"me@example.com\",\"serverUrl\":\"https://vault.example.com\"}";
                if (op == "login")
                {
                    if (Json.Str(req, "password") != "correct horse") return "{\"ok\":false,\"error\":\"bad_password\"}";
                    object code;
                    if (!req.TryGetValue("code", out code)) return "{\"ok\":false,\"error\":\"code_required\",\"message\":\"Enter the code from your authenticator app.\"}";
                    if ((string)code != "123456") return "{\"ok\":false,\"error\":\"bad_code\"}";
                    State = "unlocked";
                    return "{\"ok\":true,\"state\":\"unlocked\"}";
                }
                if (op == "lock") { State = "locked"; return "{\"ok\":true}"; }
                return "{\"ok\":false,\"error\":\"unknown\"}";
            }
        }

        static void Pipe(string home)
        {
            Store store = new Store(home);
            if (File.Exists(store.SettingsFile)) File.Delete(store.SettingsFile);
            FakeServer fake = new FakeServer();
            fake.Start();
            File.WriteAllText(store.StatusFile, "{\"version\":\"" + AppInfo.Version + "\",\"pid\":" + Process.GetCurrentProcess().Id + ",\"updatedAt\":\"" + Json.Iso(DateTime.UtcNow) + "\",\"install\":\"other\"," +
                "\"vault\":{\"state\":\"unauthenticated\"},\"ipc\":{\"pipe\":\"" + fake.Pipe + "\",\"token\":\"" + fake.Token + "\"}}");
            try
            {
                IDictionary<string, object> r = Ipc.Call(fake.Pipe, fake.Token, new Dictionary<string, object> { { "op", "status" } }, Ipc.ShortTimeout);
                Check(Json.Bool(r, "ok") == true && Json.Str(r, "state") == "unauthenticated", "a request over the pipe gets its answer");

                MainController ctl = new MainController(home, "dark", true);
                Check(ctl.ShouldWelcome(), "a first run with no settings and no account opens the welcome screen");
                ctl.ShowOffscreen();
                ctl.Choose("LocSelf");
                ctl.SetText("UrlInput", "vault.example.com");
                ctl.SetText("EmailInput", "me@example.com");
                ctl.SetPassword("MasterInput", "correct horse");
                ctl.SignIn(-1, false);
                Check(PumpUntil(delegate { return ctl.IsShown("TwoStepPanel") && !ctl.AnyBusy; }, 8000), "an account that needs a code shows the two-step step");
                Check(ctl.Password("MasterInput") == "correct horse", "the master password is kept while the code is asked for");
                Check(ctl.Text("SignInMessage") == "Enter the code from your authenticator app.", "the server's message is shown");
                ctl.SetText("CodeInput", "123456");
                ctl.SignIn(-1, false);
                Check(PumpUntil(delegate { return ctl.State == "unlocked" && !ctl.AnyBusy; }, 8000), "the second attempt with the code signs in");
                Check(ctl.Password("MasterInput") == "", "the master password is cleared once signed in");
                Check(!ctl.IsShown("SignInCard") && ctl.IsShown("LockBtn"), "a signed-in account shows lock instead of the form");
                IDictionary<string, object> cfg = store.LoadConfig();
                Check(Json.Str(cfg, "serverUrl") == "https://vault.example.com" && Json.Str(cfg, "email") == "me@example.com", "the address and email are saved for the server");
                IDictionary<string, object> last;
                lock (fake.Seen) last = fake.Seen[fake.Seen.Count - 1];
                Check(Json.Str(last, "op") == "login" && Json.Str(last, "code") == "123456" && Convert.ToInt32(last["method"]) == 0 && Json.Str(last, "serverUrl") == "https://vault.example.com", "the second request carries the method and code");
                Check(!fake.BadToken, "every request carried the token");
                Check(File.ReadAllText(store.ConfigFile).IndexOf("correct horse", StringComparison.Ordinal) < 0 && !File.Exists(store.SettingsFile) || File.ReadAllText(store.SettingsFile).IndexOf("correct horse", StringComparison.Ordinal) < 0, "the master password is written to no file");
                ctl.Window.Close();
            }
            finally
            {
                fake.Stop();
                try { Ipc.Call(fake.Pipe, fake.Token, new Dictionary<string, object> { { "op", "status" } }, 1000); } catch { }
                if (File.Exists(store.StatusFile)) File.Delete(store.StatusFile);
                if (File.Exists(store.ConfigFile)) File.Delete(store.ConfigFile);
            }
        }

        static readonly string[] Pages = { "account", "permissions", "security", "general", "updates", "activity", "about" };

        static void Contrast(string home)
        {
            foreach (string theme in new[] { "dark", "light" })
            {
                MainController ctl = new MainController(home, theme, true);
                ctl.ShowOffscreen();
                List<string> all = new List<string>();
                foreach (string p in Pages)
                {
                    ctl.Navigate(p, false);
                    Pump(60);
                    foreach (string f in ctl.ContrastFailures()) all.Add(p + ": " + f);
                }
                // Selected and checked states are where 0.3.0 went wrong, so exercise them too.
                ctl.Navigate("permissions", false);
                ctl.Choose("AccessAsk");
                ctl.Choose("AccessSession");
                Pump(60);
                foreach (string f in ctl.ContrastFailures()) all.Add("permissions (selected): " + f);
                for (int step = 1; step <= 4; step++)
                {
                    ctl.ShowWelcome(step);
                    Pump(60);
                    foreach (string f in ctl.ContrastFailures()) all.Add("welcome " + step + ": " + f);
                }
                if (theme == "dark")
                {
                    // The check must catch the 0.3.0 bug: system-black text on the dark palette.
                    ctl.Navigate("account", false);
                    System.Windows.Controls.StackPanel pg = (System.Windows.Controls.StackPanel)ctl.Window.FindName("PageAccount");
                    System.Windows.Controls.TextBlock probe = new System.Windows.Controls.TextBlock();
                    probe.Text = "probe";
                    probe.Foreground = System.Windows.Media.Brushes.Black;
                    pg.Children.Add(probe);
                    Pump(60);
                    bool caught = ctl.ContrastFailures().Exists(delegate(string f) { return f.IndexOf("probe", StringComparison.Ordinal) >= 0; });
                    pg.Children.Remove(probe);
                    Check(caught, "the contrast check catches black text on the dark theme");
                }
                Check(all.Count == 0, "every page is readable in the " + theme + " theme" + (all.Count == 0 ? "" : " (" + all.Count + "): " + string.Join(" | ", all.GetRange(0, Math.Min(6, all.Count)).ToArray())));
                ctl.Window.Close();
            }
        }
    }
}
