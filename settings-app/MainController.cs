// Bitwarden MCP Settings
// Copyright (C) 2026 ShadowsDistant. Licensed under the GNU GPL v3 or later.
//
// The window. It is the only thing that writes settings.json: the server exposes no tool that
// can, so nothing said in a chat can loosen what the assistant is allowed to do. Signing in,
// unlocking and locking go to the running server over its named pipe; a master password typed
// here goes down that pipe and nowhere else.

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Net;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Text.RegularExpressions;
using System.Threading.Tasks;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Input;
using System.Windows.Interop;
using System.Windows.Markup;
using System.Windows.Media;
using System.Windows.Media.Imaging;
using System.Windows.Threading;

namespace BitwardenMcpSettings
{
    public sealed class MainController
    {
        public readonly Window Window;
        readonly Store store;
        readonly string themeOverride;
        readonly bool still;

        SettingsModel saved;
        SettingsModel model;
        ServerStatus status;
        VaultInfo vault;
        string loadError;
        string loadedStamp;
        string statusStamp;
        string loadedAnimations;
        bool painting;
        bool navigating;
        bool justSaved;
        bool saveBarShown;
        bool closingConfirmed;
        bool refreshing;
        bool apiKeyMode;
        bool twoStep;
        bool inWelcome;
        int welcomeStep;
        int pollTick;
        string page = "account";
        UpdateInfo update;
        bool checking;
        bool downloading;
        Action<int> dialogDone;
        DispatcherTimer poll;
        DispatcherTimer savedTimer;
        FileSystemWatcher watcher;
        readonly Dictionary<Button, object> busy = new Dictionary<Button, object>();
        readonly List<Borrowed> borrowed = new List<Borrowed>();

        static readonly string[] NavPages = { "account", "permissions", "security", "general", "updates", "activity", "about" };
        static readonly int[] IdleChoices = { 5, 15, 30, 60, 240 };
        static readonly int[] RevealChoices = { 10, 30, 60, 120 };
        static readonly int[] ClipChoices = { 10, 30, 60, 120 };

        sealed class Borrowed
        {
            public FrameworkElement Element;
            public Panel Parent;
            public int Index;
            public Decorator Host;
        }

        T Find<T>(string name) where T : class
        {
            T t = Window.FindName(name) as T;
            if (t == null) throw new InvalidOperationException("The window is missing " + name);
            return t;
        }

        static string Cap(string s) { return char.ToUpperInvariant(s[0]) + s.Substring(1); }

        public static bool AnimationsOn(string mode)
        {
            if (mode == "off") return false;
            if (mode == "system") return SystemParameters.ClientAreaAnimation;
            return true;
        }

        public MainController(string home, string themeOverride, bool still)
        {
            store = new Store(home);
            this.themeOverride = themeOverride;
            this.still = still;

            status = store.LoadStatus();
            statusStamp = Store.Stamp(store.StatusFile);
            bool fromFile;
            saved = store.Load(status, out loadError, out fromFile);
            loadedStamp = store.Stamp();
            model = saved.Clone();
            loadedAnimations = model.Animations;
            vault = status != null ? status.Vault : null;
            update = store.LoadUpdateCache();

            Motion.On = !still && AnimationsOn(model.Animations);
            string xaml;
            using (Stream s = Assembly.GetExecutingAssembly().GetManifestResourceStream("MainWindow.xaml"))
            using (StreamReader r = new StreamReader(s))
            {
                xaml = r.ReadToEnd();
            }
            // Animations off: every storyboard in the templates lands on its end value at once.
            if (!Motion.On) xaml = Regex.Replace(xaml, "Duration=\"0:0:0\\.\\d+\"", "Duration=\"0:0:0\"");
            Window = (Window)XamlReader.Parse(xaml);
            ApplyTheme();
            Window.SourceInitialized += delegate { Theme.TitleBar(Window, Dark); };

            BitmapSource logo = LoadIcon();
            if (logo != null)
            {
                Find<Image>("Logo").Source = logo;
                Find<Image>("AboutLogo").Source = logo;
                Find<Image>("WelcomeLogo").Source = logo;
                Window.Icon = logo;
            }

            BuildPills("IdlePills", "idle", IdleChoices, MinutesLabel);
            BuildPills("RevealPills", "reveal", RevealChoices, SecondsLabel);
            BuildPills("ClipPills", "clip", ClipChoices, SecondsLabel);
            BuildDots();
            Wire();
            Find<TextBlock>("FilePath").Text = store.SettingsFile;
            Find<TextBlock>("AboutVersion").Text = "Version " + AppInfo.Version;
            Find<TextBlock>("AppVersion").Text = AppInfo.Version;
            FillSignInFromConfig();
            Paint();
            Navigate("account", false);
        }

        public bool Dark { get { return themeOverride != null ? themeOverride == "dark" : Theme.Resolve(model.Theme); } }

        void ApplyTheme()
        {
            bool d = Dark;
            Theme.Apply(Window.Resources, d);
            Theme.TitleBar(Window, d);
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

        // =====================================================================================
        // Small helpers
        // =====================================================================================

        delegate string Labeller(int v);

        static string SecondsLabel(int v)
        {
            return v < 60 ? v + " seconds" : v == 60 ? "1 minute" : (v % 60 == 0 ? (v / 60) + " minutes" : v + " seconds");
        }

        static string MinutesLabel(int v)
        {
            if (v < 60) return v + " min";
            if (v % 60 != 0) return v + " min";
            return (v / 60) + (v == 60 ? " hour" : " hours");
        }

        static string Ago(DateTime utc)
        {
            TimeSpan d = DateTime.UtcNow - utc;
            if (d.TotalMinutes < 1) return "just now";
            if (d.TotalHours < 1) return ((int)d.TotalMinutes) + " min ago";
            if (d.TotalDays < 1) return ((int)d.TotalHours) + (d.TotalHours < 2 ? " hour ago" : " hours ago");
            return ((int)d.TotalDays) + (d.TotalDays < 2 ? " day ago" : " days ago");
        }

        void ShowMsg(TextBlock t, string text, string brushKey)
        {
            t.Text = text;
            t.SetResourceReference(TextBlock.ForegroundProperty, brushKey);
            if (t.Visibility != Visibility.Visible)
            {
                t.Visibility = Visibility.Visible;
                Motion.Enter(t, 4);
            }
        }

        static void HideMsg(TextBlock t)
        {
            t.Visibility = Visibility.Collapsed;
            t.Text = "";
        }

        static void Show(UIElement el, bool on)
        {
            el.Visibility = on ? Visibility.Visible : Visibility.Collapsed;
        }

        static void Open(string url)
        {
            try { Process.Start(new ProcessStartInfo(url) { UseShellExecute = true }); }
            catch { }
        }

        void SetBusy(Button b, string label)
        {
            if (busy.ContainsKey(b)) return;
            busy[b] = b.Content;
            StackPanel sp = new StackPanel();
            sp.Orientation = Orientation.Horizontal;
            sp.Children.Add(Motion.Spinner(14, b.Foreground));
            TextBlock t = new TextBlock();
            t.Text = label;
            t.Margin = new Thickness(8, 0, 0, 0);
            t.VerticalAlignment = VerticalAlignment.Center;
            t.Foreground = b.Foreground;
            sp.Children.Add(t);
            b.Content = sp;
            b.IsHitTestVisible = false;
            b.Focusable = false;
        }

        void ClearBusy(Button b)
        {
            object c;
            if (!busy.TryGetValue(b, out c)) return;
            busy.Remove(b);
            b.Content = c;
            b.IsHitTestVisible = true;
            b.Focusable = true;
        }

        bool IsBusy(Button b) { return busy.ContainsKey(b); }

        void TogglePlaceholder(PasswordBox pb)
        {
            pb.ApplyTemplate();
            TextBlock ph = pb.Template == null ? null : pb.Template.FindName("Ph", pb) as TextBlock;
            if (ph != null) ph.Visibility = pb.Password.Length == 0 ? Visibility.Visible : Visibility.Collapsed;
        }

        // =====================================================================================
        // Pills
        // =====================================================================================

        void BuildPills(string panel, string group, int[] values, Labeller label)
        {
            WrapPanel wp = Find<WrapPanel>(panel);
            foreach (int v in values) wp.Children.Add(MakePill(group, v, label(v)));
        }

        RadioButton MakePill(string group, int value, string text)
        {
            RadioButton rb = new RadioButton();
            rb.Style = (Style)Window.FindResource("Pill");
            rb.GroupName = group;
            rb.Content = text;
            rb.Tag = value;
            rb.Checked += delegate { Changed(); };
            return rb;
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
                match = MakePill(group, value, label(value));
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

        // =====================================================================================
        // Wiring
        // =====================================================================================

        void Wire()
        {
            foreach (string p in NavPages)
            {
                string name = p;
                Find<RadioButton>("Nav" + Cap(p)).Checked += delegate { if (!navigating) Navigate(name, true); };
            }

            RoutedEventHandler changed = delegate { Changed(); };
            foreach (string n in new[] { "AccessAsk", "AccessSession", "AccessNever" }) Find<RadioButton>(n).Checked += changed;
            foreach (string n in new[] { "LockIdle", "LockExit", "LockNever" }) Find<RadioButton>(n).Checked += changed;
            foreach (string n in new[] { "Cards", "AllowChanges", "AllowTrash", "UpdateCheck" })
            {
                Find<CheckBox>(n).Checked += changed;
                Find<CheckBox>(n).Unchecked += changed;
            }
            foreach (string n in new[] { "ThemeSystem", "ThemeLight", "ThemeDark" })
            {
                Find<RadioButton>(n).Checked += delegate
                {
                    Changed();
                    if (!painting) ApplyTheme();
                };
            }
            foreach (string n in new[] { "AnimOn", "AnimSystem", "AnimOff" })
            {
                Find<RadioButton>(n).Checked += delegate
                {
                    Changed();
                    if (!painting && !still) Motion.On = AnimationsOn(model.Animations);
                    PaintNotes();
                };
            }

            TextBox input = Find<TextBox>("SiteInput");
            input.TextChanged += delegate { HideMsg(Find<TextBlock>("SiteError")); };
            input.KeyDown += delegate(object s, KeyEventArgs e) { if (e.Key == Key.Enter) { AddSite(); e.Handled = true; } };
            Find<Button>("SiteAdd").Click += delegate { AddSite(); };

            Find<Button>("SaveBtn").Click += delegate { Save(); };
            Find<Button>("DiscardBtn").Click += delegate { Discard(); };
            Find<Button>("ResetDefaults").Click += delegate
            {
                Ask("Reset to defaults?", "Every setting goes back to how it was when you installed. Nothing is saved until you press Save.", "Reset", false, null, delegate(int r)
                {
                    if (r != 1) return;
                    SettingsModel d = new SettingsModel();
                    d.Extra = new Dictionary<string, object>(model.Extra);
                    model = d;
                    Paint();
                    ApplyTheme();
                });
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
            Find<Button>("OpenHelp").Click += delegate { Open("https://github.com/ShadowsDistant/Vaultwarden-MCP#readme"); };
            Find<Button>("OpenIssues").Click += delegate { Open("https://github.com/ShadowsDistant/Vaultwarden-MCP/issues"); };
            Find<Button>("OpenRepo").Click += delegate { Open("https://github.com/ShadowsDistant/Vaultwarden-MCP"); };
            Find<Button>("DesktopShortcutBtn").Click += delegate { AddShortcut(true, true); };
            Find<Button>("StartShortcutBtn").Click += delegate { AddShortcut(false, true); };

            // ---- account ----
            foreach (string n in new[] { "LocUs", "LocEu", "LocSelf" }) Find<RadioButton>(n).Checked += delegate { PaintLocation(); };
            Find<TextBox>("UrlInput").TextChanged += delegate { HideMsg(Find<TextBlock>("UrlError")); };
            Find<Button>("ModeLink").Click += delegate { SetApiKeyMode(!apiKeyMode); };
            Find<Button>("UseKeyLink").Click += delegate { SetApiKeyMode(true); };
            foreach (string n in new[] { "MethodApp", "MethodEmail", "MethodKey" }) Find<RadioButton>(n).Checked += delegate { PaintMethod(); };
            Find<Button>("SendCodeBtn").Click += delegate { SignIn(1, true); };
            Find<Button>("SignInBtn").Click += delegate { SignIn(-1, false); };
            Find<Button>("SaveLocBtn").Click += delegate { SaveLocationOnly(); };
            Find<Button>("UnlockBtn").Click += delegate { Unlock(); };
            Find<Button>("LockBtn").Click += delegate { LockVault(Find<Button>("LockBtn")); };
            Find<Button>("LockNowBtn2").Click += delegate { LockVault(Find<Button>("LockNowBtn2")); };
            Find<Button>("SignOutBtn").Click += delegate
            {
                Ask("Sign out?", "The assistant loses access to your vault until you sign in again here.", "Sign out", true, null, delegate(int r) { if (r == 1) SignOut(); });
            };
            KeyEventHandler enterSignIn = delegate(object s, KeyEventArgs e) { if (e.Key == Key.Enter) { SignIn(-1, false); e.Handled = true; } };
            Find<PasswordBox>("MasterInput").KeyDown += enterSignIn;
            Find<TextBox>("CodeInput").KeyDown += enterSignIn;
            Find<PasswordBox>("UnlockPassword").KeyDown += delegate(object s, KeyEventArgs e) { if (e.Key == Key.Enter) { Unlock(); e.Handled = true; } };
            foreach (string n in new[] { "MasterInput", "UnlockPassword", "ClientSecretInput" })
            {
                PasswordBox pb = Find<PasswordBox>(n);
                pb.PasswordChanged += delegate { TogglePlaceholder(pb); };
                pb.Loaded += delegate { TogglePlaceholder(pb); };
            }

            // ---- updates ----
            Find<Button>("CheckBtn").Click += delegate { CheckUpdates(true); };
            Find<Button>("UpdateBtn").Click += delegate { InstallUpdate(); };
            Find<Button>("NotesBtn").Click += delegate { Open(update != null && Updater.TrustedPage(update.Url) ? update.Url : Updater.ReleasesPage); };
            Find<Button>("UpdateBannerBtn").Click += delegate { Navigate("updates", true); };
            Find<Button>("RefreshActivity").Click += delegate { LoadActivity(); };

            // ---- welcome ----
            Find<Button>("SkipWelcome").Click += delegate { SkipWelcome(); };
            Find<Button>("WBack").Click += delegate { if (welcomeStep > 1) GoStep(welcomeStep - 1); };
            Find<Button>("WNext").Click += delegate { WelcomeNext(); };

            // ---- dialog ----
            Find<Button>("DlgOk").Click += delegate { CloseDialog(1); };
            Find<Button>("DlgAlt").Click += delegate { CloseDialog(2); };
            Find<Button>("DlgCancel").Click += delegate { CloseDialog(0); };

            Window.PreviewKeyDown += delegate(object s, KeyEventArgs e)
            {
                if (e.Key == Key.S && (Keyboard.Modifiers & ModifierKeys.Control) != 0 && !inWelcome) { Save(); e.Handled = true; }
                else if (e.Key == Key.Escape && Find<Grid>("DialogLayer").Visibility == Visibility.Visible) { CloseDialog(0); e.Handled = true; }
            };

            Window.Activated += delegate
            {
                if (still) return;
                RefreshStatus(true);
                if (!Dirty() && store.Stamp() != loadedStamp) Reload();
            };

            Window.Loaded += delegate
            {
                PlacePill(false);
                if (still) return;
                StartBackground();
            };
            Find<StackPanel>("NavList").SizeChanged += delegate { PlacePill(false); };

            Window.Closing += delegate(object s, System.ComponentModel.CancelEventArgs e)
            {
                if (closingConfirmed || still || !Dirty()) { Cleanup(); return; }
                e.Cancel = true;
                Ask("Save your changes?", "You changed some settings but haven't saved them yet.", "Save", false, "Don't save", delegate(int r)
                {
                    if (r == 1 && Save()) { closingConfirmed = true; Window.Close(); }
                    else if (r == 2) { closingConfirmed = true; Window.Close(); }
                });
            };
        }

        void StartBackground()
        {
            poll = new DispatcherTimer();
            poll.Interval = TimeSpan.FromSeconds(2);
            poll.Tick += delegate { Poll(); };
            poll.Start();

            try
            {
                Directory.CreateDirectory(store.Home);
                watcher = new FileSystemWatcher(store.Home, "launch-request.json");
                FileSystemEventHandler h = delegate { Window.Dispatcher.BeginInvoke(new Action(delegate { DelayThen(150, HandleLaunchRequest); })); };
                watcher.Created += h;
                watcher.Changed += h;
                watcher.Renamed += delegate { Window.Dispatcher.BeginInvoke(new Action(delegate { DelayThen(150, HandleLaunchRequest); })); };
                watcher.EnableRaisingEvents = true;
            }
            catch { watcher = null; }

            Microsoft.Win32.SystemEvents.UserPreferenceChanged += OnUserPreferenceChanged;

            if (saved.UpdateCheck && (update == null || (DateTime.UtcNow - update.CheckedAt).TotalHours >= 6)) CheckUpdates(false);
            RefreshVault();
        }

        void OnUserPreferenceChanged(object sender, Microsoft.Win32.UserPreferenceChangedEventArgs e)
        {
            Window.Dispatcher.BeginInvoke(new Action(delegate { if (model.Theme == "system" && themeOverride == null) ApplyTheme(); }));
        }

        void Cleanup()
        {
            if (poll != null) poll.Stop();
            if (watcher != null) { watcher.EnableRaisingEvents = false; watcher.Dispose(); watcher = null; }
            Microsoft.Win32.SystemEvents.UserPreferenceChanged -= OnUserPreferenceChanged;
        }

        void DelayThen(int ms, Action a)
        {
            DispatcherTimer t = new DispatcherTimer();
            t.Interval = TimeSpan.FromMilliseconds(ms);
            t.Tick += delegate { t.Stop(); a(); };
            t.Start();
        }

        // =====================================================================================
        // Navigation
        // =====================================================================================

        public void Navigate(string name, bool animate)
        {
            if (name == "welcome") { ShowWelcome(1); return; }
            if (Array.IndexOf(NavPages, name) < 0) name = "account";
            page = name;
            foreach (string p in NavPages) Show(Find<StackPanel>("Page" + Cap(p)), p == name);
            navigating = true;
            Find<RadioButton>("Nav" + Cap(name)).IsChecked = true;
            navigating = false;
            Find<ScrollViewer>("Scroller").ScrollToVerticalOffset(0);
            StackPanel pg = Find<StackPanel>("Page" + Cap(name));
            if (animate) Motion.Enter(pg, 12);
            else { pg.BeginAnimation(UIElement.OpacityProperty, null); pg.Opacity = 1; }
            PlacePill(animate);
            if (name == "activity") LoadActivity();
            if (name == "account") RefreshVault();
            if (name == "updates") PaintUpdates();
            PaintUpdateBanner();
        }

        void PlacePill(bool animate)
        {
            Window.Dispatcher.BeginInvoke(DispatcherPriority.Loaded, new Action(delegate
            {
                RadioButton nb = Find<RadioButton>("Nav" + Cap(page));
                StackPanel list = Find<StackPanel>("NavList");
                Border pill = Find<Border>("NavPill");
                if (nb.ActualHeight <= 0 || list.ActualWidth <= 0) return;
                Point pt = nb.TranslatePoint(new Point(0, 0), list);
                pill.Width = list.ActualWidth;
                pill.Height = nb.ActualHeight;
                TranslateTransform t = pill.RenderTransform as TranslateTransform;
                if (t == null) return;
                if (animate) Motion.To(t, TranslateTransform.YProperty, pt.Y, 240);
                else { t.BeginAnimation(TranslateTransform.YProperty, null); t.Y = pt.Y; }
            }));
        }

        // =====================================================================================
        // Settings
        // =====================================================================================

        public void Reload()
        {
            status = store.LoadStatus();
            statusStamp = Store.Stamp(store.StatusFile);
            bool fromFile;
            saved = store.Load(status, out loadError, out fromFile);
            loadedStamp = store.Stamp();
            model = saved.Clone();
            Paint();
            ApplyTheme();
        }

        void Collect()
        {
            if (painting) return;
            model.Access = Find<RadioButton>("AccessNever").IsChecked == true ? "never" : Find<RadioButton>("AccessSession").IsChecked == true ? "session" : "ask";
            model.Cards = Find<CheckBox>("Cards").IsChecked == true;
            model.AllowChanges = Find<CheckBox>("AllowChanges").IsChecked == true;
            model.AllowTrash = Find<CheckBox>("AllowTrash").IsChecked == true;
            model.UpdateCheck = Find<CheckBox>("UpdateCheck").IsChecked == true;
            model.LockMode = Find<RadioButton>("LockIdle").IsChecked == true ? "idle" : Find<RadioButton>("LockNever").IsChecked == true ? "never" : "exit";
            model.IdleLockMinutes = PillValue("IdlePills", model.IdleLockMinutes);
            model.RevealSeconds = PillValue("RevealPills", model.RevealSeconds);
            model.ClipboardClearSeconds = PillValue("ClipPills", model.ClipboardClearSeconds);
            model.Theme = Find<RadioButton>("ThemeLight").IsChecked == true ? "light" : Find<RadioButton>("ThemeDark").IsChecked == true ? "dark" : "system";
            model.Animations = Find<RadioButton>("AnimOff").IsChecked == true ? "off" : Find<RadioButton>("AnimSystem").IsChecked == true ? "system" : "on";
        }

        void Changed()
        {
            if (painting) return;
            justSaved = false;
            Collect();
            PaintDependents();
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
                Find<CheckBox>("AllowTrash").IsChecked = model.AllowTrash;
                Find<CheckBox>("UpdateCheck").IsChecked = model.UpdateCheck;
                Find<RadioButton>(model.LockMode == "idle" ? "LockIdle" : model.LockMode == "never" ? "LockNever" : "LockExit").IsChecked = true;
                SelectPill("IdlePills", "idle", model.IdleLockMinutes, MinutesLabel);
                SelectPill("RevealPills", "reveal", model.RevealSeconds, SecondsLabel);
                SelectPill("ClipPills", "clip", model.ClipboardClearSeconds, SecondsLabel);
                Find<RadioButton>(model.Theme == "light" ? "ThemeLight" : model.Theme == "dark" ? "ThemeDark" : "ThemeSystem").IsChecked = true;
                Find<RadioButton>(model.Animations == "off" ? "AnimOff" : model.Animations == "system" ? "AnimSystem" : "AnimOn").IsChecked = true;
                PaintSites();
            }
            finally
            {
                painting = false;
            }
            PaintDependents();
            PaintStatus();
            PaintAccount();
            PaintUpdates();
            PaintFooter();
            PaintNotes();
        }

        /** Controls whose visibility or state follows another control. */
        void PaintDependents()
        {
            bool idle = model.LockMode == "idle", never = model.LockMode == "never";
            UIElement idleRow = Find<StackPanel>("IdleRow"), warn = Find<Border>("NeverWarning");
            if (idle != (idleRow.Visibility == Visibility.Visible)) Motion.Slide(idleRow, idle, -6);
            if (never != (warn.Visibility == Visibility.Visible)) Motion.Slide(warn, never, -6);

            CheckBox trash = Find<CheckBox>("AllowTrash");
            trash.IsEnabled = model.AllowChanges;
            Grid row = Find<Grid>("TrashRow");
            Motion.To(row, UIElement.OpacityProperty, model.AllowChanges ? 1.0 : 0.5, 150);
        }

        void PaintNotes()
        {
            TextBlock note = Find<TextBlock>("CardsNote");
            string text = null;
            if (status != null && status.Running && model.Cards != status.CardsEnabled)
            {
                text = "Restart your AI app to " + (model.Cards ? "show" : "hide") + " cards. Everything else applies without a restart.";
            }
            else if (status != null && status.CardsSupported == false && model.Cards)
            {
                text = "The AI app you're using can't show cards, so it uses plain text either way.";
            }
            if (text == null) HideMsg(note); else ShowMsg(note, text, "Warn");

            string anim = "Page transitions and small motion in this window.";
            if (model.Animations == "system" && !SystemParameters.ClientAreaAnimation) anim += " Animations are turned off in Windows, so this means none.";
            if (model.Animations != loadedAnimations) anim += " Button and switch effects follow the next time this window opens.";
            Find<TextBlock>("AnimDesc").Text = anim;
        }

        void PaintFooter()
        {
            bool dirty = Dirty() || loadError != null;
            Border bar = Find<Border>("SaveBar");
            TextBlock f = Find<TextBlock>("FooterText");
            TextBlock icon = Find<TextBlock>("SaveIcon");
            Button save = Find<Button>("SaveBtn"), discard = Find<Button>("DiscardBtn");
            if (dirty)
            {
                if (savedTimer != null) savedTimer.Stop();
                f.Text = loadError != null && !Dirty() ? "Save to repair your settings file." : "You have unsaved changes.";
                icon.Text = ((char)0xE70F).ToString();
                icon.SetResourceReference(TextBlock.ForegroundProperty, "Accent");
                Show(save, true);
                Show(discard, Dirty());
                if (!saveBarShown || bar.Visibility != Visibility.Visible) Motion.Slide(bar, true, 40);
                saveBarShown = true;
            }
            else if (justSaved)
            {
                f.Text = "Saved. The assistant uses these from its next request.";
                icon.Text = ((char)0xE73E).ToString();
                icon.SetResourceReference(TextBlock.ForegroundProperty, "Success");
                Show(save, false);
                Show(discard, false);
                if (bar.Visibility != Visibility.Visible) Motion.Slide(bar, true, 40);
                saveBarShown = true;
                if (savedTimer != null) savedTimer.Stop();
                savedTimer = new DispatcherTimer();
                savedTimer.Interval = TimeSpan.FromMilliseconds(still ? 1 : 1800);
                savedTimer.Tick += delegate
                {
                    savedTimer.Stop();
                    if (!Dirty() && loadError == null) { justSaved = false; Motion.Slide(bar, false, 40); saveBarShown = false; }
                };
                savedTimer.Start();
            }
            else if (saveBarShown)
            {
                Motion.Slide(bar, false, 40);
                saveBarShown = false;
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
                Ask("Couldn't save", "Your settings couldn't be saved. " + e.Message, "OK", false, null, null);
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

        void Discard()
        {
            model = saved.Clone();
            Paint();
            ApplyTheme();
            if (!still) Motion.On = AnimationsOn(model.Animations);
        }

        // ---- trusted sites ----

        void PaintSites()
        {
            StackPanel list = Find<StackPanel>("SiteList");
            list.Children.Clear();
            foreach (string site in model.TrustedSites)
            {
                string entry = site;
                Border row = new Border();
                row.SetResourceReference(Border.BackgroundProperty, "Surface2");
                row.SetResourceReference(Border.BorderBrushProperty, "Line");
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
                string refused = RefusedByServer(entry);
                Border badge = new Border();
                badge.Width = 22;
                badge.Height = 22;
                badge.CornerRadius = new CornerRadius(6);
                badge.SetResourceReference(Border.BackgroundProperty, refused != null ? "DangerSoft" : "SuccessSoft");
                badge.Margin = new Thickness(0, 0, 10, 0);
                TextBlock tick = new TextBlock();
                tick.Text = refused != null ? "!" : Ch.Tick;
                tick.FontWeight = FontWeights.Bold;
                tick.SetResourceReference(TextBlock.ForegroundProperty, refused != null ? "Danger" : "Success");
                tick.HorizontalAlignment = HorizontalAlignment.Center;
                tick.VerticalAlignment = VerticalAlignment.Center;
                badge.Child = tick;
                if (refused != null) badge.ToolTip = refused;
                g.Children.Add(badge);

                TextBlock t = new TextBlock();
                t.Text = entry;
                t.VerticalAlignment = VerticalAlignment.Center;
                t.TextTrimming = TextTrimming.CharacterEllipsis;
                t.SetResourceReference(TextBlock.ForegroundProperty, "Fg");
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
            Show(Find<TextBlock>("SiteEmpty"), model.TrustedSites.Count == 0);

            TextBlock rejected = Find<TextBlock>("SiteRejected");
            List<string> lines = new List<string>();
            if (status != null)
            {
                foreach (KeyValuePair<string, string> r in status.Rejected)
                {
                    if (!model.TrustedSites.Contains(r.Key)) continue;
                    lines.Add(r.Value.IndexOf(r.Key, StringComparison.OrdinalIgnoreCase) >= 0 ? r.Value : r.Key + ": " + r.Value);
                }
            }
            if (lines.Count == 0) HideMsg(rejected);
            else ShowMsg(rejected, "The extension isn't using these:\n" + string.Join("\n", lines.ToArray()), "Danger");
        }

        void AddSite()
        {
            TextBox input = Find<TextBox>("SiteInput");
            TextBlock err = Find<TextBlock>("SiteError");
            string reason;
            string host = Sites.Normalise(input.Text, out reason);
            if (host == null) { ShowMsg(err, reason, "Danger"); return; }
            if (model.TrustedSites.Contains(host)) { ShowMsg(err, host + " is already on the list.", "Danger"); return; }
            model.TrustedSites.Add(host);
            input.Text = "";
            PaintSites();
            Changed();
            input.Focus();
        }

        string RefusedByServer(string entry)
        {
            if (status == null) return null;
            foreach (KeyValuePair<string, string> r in status.Rejected)
            {
                if (string.Equals(r.Key, entry, StringComparison.OrdinalIgnoreCase)) return r.Value;
            }
            return null;
        }

        // =====================================================================================
        // Server status
        // =====================================================================================

        void Poll()
        {
            pollTick++;
            RefreshStatus(pollTick % 3 == 0);
            if ((page == "account" || inWelcome) && pollTick % 3 == 0) RefreshVault();
            if (!Dirty() && loadError == null && store.Stamp() != loadedStamp) Reload();
        }

        void RefreshStatus(bool recheckProcess)
        {
            string st = Store.Stamp(store.StatusFile);
            bool changed = st != statusStamp;
            if (!changed && !recheckProcess) return;
            bool wasRunning = status != null && status.Running;
            bool couldTalk = status != null && status.CanTalk;
            ServerStatus fresh = store.LoadStatus();
            statusStamp = st;
            status = fresh;
            if (!changed && status != null && wasRunning == status.Running && couldTalk == status.CanTalk) return;
            if (status != null && status.Vault != null && (!status.CanTalk || vault == null)) vault = status.Vault;
            PaintStatus();
            PaintAccount();
            PaintUpdates();
            PaintNotes();
            if (status != null && status.CanTalk && !couldTalk) RefreshVault();
        }

        void PaintStatus()
        {
            TextBlock title = Find<TextBlock>("ServerTitle"), sub = Find<TextBlock>("ServerSub");
            System.Windows.Shapes.Ellipse dot = Find<System.Windows.Shapes.Ellipse>("ServerDot");
            System.Windows.Shapes.Ellipse halo = Find<System.Windows.Shapes.Ellipse>("ServerHalo");
            if (status == null)
            {
                title.Text = "Not set up yet";
                sub.Text = "Turn on the Bitwarden extension in your AI app.";
                dot.SetResourceReference(System.Windows.Shapes.Shape.FillProperty, "Faint");
                Motion.Pulse(halo, false);
            }
            else if (status.Running)
            {
                title.Text = "Extension running";
                string host = vault != null && !string.IsNullOrEmpty(vault.ServerHost) ? vault.ServerHost : status.ServerHost;
                sub.Text = status.CanTalk
                    ? (string.IsNullOrEmpty(host) ? "Version " + status.Version : host)
                    : "Version " + status.Version + ". Update it to sign in from here.";
                dot.SetResourceReference(System.Windows.Shapes.Shape.FillProperty, "Success");
                Motion.Pulse(halo, true);
            }
            else
            {
                title.Text = "Extension not running";
                sub.Text = status.UpdatedAt.HasValue ? "Last seen " + Ago(status.UpdatedAt.Value) + ". Open your AI app to start it." : "Open your AI app to start it.";
                dot.SetResourceReference(System.Windows.Shapes.Shape.FillProperty, "Faint");
                Motion.Pulse(halo, false);
            }

            Border banner = Find<Border>("Banner");
            TextBlock bannerText = Find<TextBlock>("BannerText");
            string text = null;
            if (loadError != null)
                text = "Your settings file couldn't be read (" + loadError + "), so the extension is using its strictest settings: no secrets for the assistant and no changes. Review your choices and press Save to repair it.";
            else if (status != null && !string.IsNullOrEmpty(status.SettingsError) && status.Running)
                text = "The extension reported a problem reading your settings, so it is using its strictest settings. Saving here rewrites the file.";
            if (text != null && !inWelcome)
            {
                bannerText.Text = text;
                if (banner.Visibility != Visibility.Visible) Motion.Slide(banner, true, -8);
            }
            else banner.Visibility = Visibility.Collapsed;
            PaintUpdateBanner();
        }

        async void RefreshVault()
        {
            if (refreshing || still || status == null || !status.CanTalk) return;
            if (busy.Count > 0) return;
            refreshing = true;
            string pipe = status.IpcPipe, token = status.IpcToken;
            try
            {
                Dictionary<string, object> req = new Dictionary<string, object>();
                req["op"] = "status";
                IDictionary<string, object> r = await Task.Run(() => Ipc.Call(pipe, token, req, Ipc.ShortTimeout));
                if (Json.Bool(r, "ok") == true)
                {
                    VaultInfo v = VaultInfo.From(r);
                    if (v != null)
                    {
                        bool wasSignedIn = vault != null && vault.SignedIn;
                        vault = v;
                        if (wasSignedIn && !v.SignedIn) FillSignInFromConfig();
                        PaintAccount();
                        PaintStatus();
                    }
                }
            }
            catch (IpcException) { }
            catch (Exception) { }
            finally
            {
                refreshing = false;
            }
        }

        // =====================================================================================
        // Account
        // =====================================================================================

        bool CanTalk { get { return status != null && status.CanTalk; } }

        void FillSignInFromConfig()
        {
            IDictionary<string, object> cfg = store.LoadConfig();
            string url = Json.Str(cfg, "serverUrl");
            string email = Json.Str(cfg, "email");
            if (url == null && vault != null) url = vault.ServerUrl;
            if (email == null && vault != null) email = vault.Email;
            string checkedUrl, err;
            checkedUrl = url == null ? null : VaultUrl.Check(url, out err);
            if (checkedUrl == null || checkedUrl == VaultUrl.Us) Find<RadioButton>("LocUs").IsChecked = true;
            else if (checkedUrl == VaultUrl.Eu) Find<RadioButton>("LocEu").IsChecked = true;
            else
            {
                Find<RadioButton>("LocSelf").IsChecked = true;
                Find<TextBox>("UrlInput").Text = checkedUrl;
            }
            if (!string.IsNullOrEmpty(email)) Find<TextBox>("EmailInput").Text = email;
            PaintLocation();
        }

        void PaintLocation()
        {
            bool self = Find<RadioButton>("LocSelf").IsChecked == true;
            UIElement row = Find<StackPanel>("SelfHostRow");
            if (self != (row.Visibility == Visibility.Visible)) Motion.Slide(row, self, -6);
            string note = self
                ? "Works with Vaultwarden and self-hosted Bitwarden servers."
                : Find<RadioButton>("LocEu").IsChecked == true
                    ? "vault.bitwarden.eu, Bitwarden's cloud in the European Union."
                    : "vault.bitwarden.com, Bitwarden's cloud in the United States.";
            Find<TextBlock>("LocNote").Text = note;
            HideMsg(Find<TextBlock>("UrlError"));
        }

        string LocationUrl(out string error)
        {
            error = null;
            if (Find<RadioButton>("LocEu").IsChecked == true) return VaultUrl.Eu;
            if (Find<RadioButton>("LocSelf").IsChecked == true) return VaultUrl.Check(Find<TextBox>("UrlInput").Text, out error);
            return VaultUrl.Us;
        }

        void SetApiKeyMode(bool on)
        {
            apiKeyMode = on;
            Show(Find<StackPanel>("PwMode"), !on);
            UIElement key = Find<StackPanel>("KeyMode");
            if (on != (key.Visibility == Visibility.Visible)) Motion.Slide(key, on, -6);
            Find<Button>("ModeLink").Content = on ? "Use your email and master password instead" : "Use an API key instead";
            if (on && twoStep)
            {
                twoStep = false;
                Show(Find<Border>("TwoStepPanel"), false);
            }
            HideMsg(Find<TextBlock>("SignInMessage"));
        }

        int SelectedMethod()
        {
            if (Find<RadioButton>("MethodEmail").IsChecked == true) return 1;
            if (Find<RadioButton>("MethodKey").IsChecked == true) return 3;
            return 0;
        }

        void PaintMethod()
        {
            int m = SelectedMethod();
            Show(Find<Button>("SendCodeBtn"), m == 1);
            Find<TextBox>("CodeInput").Tag = m == 3 ? "Touch your YubiKey" : m == 1 ? "Code from the email" : "6-digit code from your app";
        }

        void PaintAccount()
        {
            VaultInfo v = vault;
            bool talk = CanTalk;
            string state = v != null ? v.State : null;
            bool signedIn = v != null && v.SignedIn;
            IDictionary<string, object> cfg = store.LoadConfig();
            string email = v != null && !string.IsNullOrEmpty(v.Email) ? v.Email : Json.Str(cfg, "email");
            string host = v != null && !string.IsNullOrEmpty(v.ServerHost) ? v.ServerHost : VaultUrl.Host(Json.Str(cfg, "serverUrl"));

            TextBlock title = Find<TextBlock>("AcctTitle"), sub = Find<TextBlock>("AcctSub");
            if (signedIn)
            {
                title.Text = string.IsNullOrEmpty(email) ? "Signed in" : email;
                string s = string.IsNullOrEmpty(host) ? "" : host;
                if (v.LastSync.HasValue) s += (s.Length > 0 ? Ch.Dot : "") + "synced " + Ago(v.LastSync.Value);
                if (!talk) s += (s.Length > 0 ? Ch.Dot : "") + "extension not running";
                sub.Text = s;
            }
            else if (state == "no_cli")
            {
                title.Text = "The Bitwarden command-line tool is missing";
                sub.Text = "Reinstall the extension to put it back.";
            }
            else
            {
                title.Text = "Not signed in";
                sub.Text = status == null
                    ? "Turn on the Bitwarden extension in your AI app, then sign in here."
                    : !talk
                        ? (status.Running ? "This version of the extension can't take a sign-in from here. Update it, or ask your assistant to unlock your vault." : "The extension isn't running. Open your AI app to sign in.")
                        : "Choose where your vault is, then sign in below.";
            }

            Border chip = Find<Border>("AcctChip");
            TextBlock chipText = Find<TextBlock>("AcctChipText");
            System.Windows.Shapes.Ellipse dot = Find<System.Windows.Shapes.Ellipse>("AcctDot");
            string label, fill, bg;
            if (!talk) { label = "Offline"; fill = "Faint"; bg = "Surface3"; }
            else if (state == "unlocked") { label = "Unlocked"; fill = "Success"; bg = "SuccessSoft"; }
            else if (state == "locked") { label = "Locked"; fill = "Warn"; bg = "WarnSoft"; }
            else { label = "Signed out"; fill = "Faint"; bg = "Surface3"; }
            chipText.Text = label;
            dot.SetResourceReference(System.Windows.Shapes.Shape.FillProperty, fill);
            chip.SetResourceReference(Border.BackgroundProperty, bg);

            TextBlock avatar = Find<TextBlock>("AvatarText");
            if (signedIn && !string.IsNullOrEmpty(email) && char.IsLetterOrDigit(email[0]))
            {
                avatar.FontFamily = new FontFamily("Segoe UI Variable Display, Segoe UI");
                avatar.FontWeight = FontWeights.SemiBold;
                avatar.Text = char.ToUpperInvariant(email[0]).ToString();
            }
            else
            {
                avatar.FontFamily = (FontFamily)Window.FindResource("Icons");
                avatar.FontWeight = FontWeights.Normal;
                avatar.Text = ((char)0xE77B).ToString();
            }

            bool showUnlock = talk && state == "locked";
            Grid unlockRow = Find<Grid>("UnlockRow");
            if (showUnlock != (unlockRow.Visibility == Visibility.Visible)) Motion.Slide(unlockRow, showUnlock, -6);
            Show(Find<Button>("LockBtn"), talk && state == "unlocked");
            Show(Find<Button>("SignOutBtn"), talk && signedIn);
            Show(Find<WrapPanel>("AcctActions"), talk && signedIn);

            bool showSignIn = !signedIn && state != "no_cli";
            Show(Find<TextBlock>("SignInTitle"), showSignIn);
            Show(Find<Border>("SignInCard"), showSignIn);
            Find<Button>("SignInBtn").IsEnabled = talk;
            Show(Find<Button>("SaveLocBtn"), !talk);
            Show(Find<TextBlock>("ServerNote"), !talk);

            // The welcome screen's sign-in step follows the same state.
            Show(Find<Border>("WSignedIn"), signedIn);
            Show(Find<Border>("WCredsHost"), !signedIn);
            Find<TextBlock>("WSignedInText").Text = signedIn
                ? "You're signed in" + (string.IsNullOrEmpty(email) ? "" : " as " + email) + (string.IsNullOrEmpty(host) ? "." : " at " + host + ".")
                : "";
            if (inWelcome) PaintWelcomeButtons();
        }

        void SetFormEnabled(bool on)
        {
            foreach (string n in new[] { "LocUs", "LocEu", "LocSelf", "MethodApp", "MethodEmail", "MethodKey" }) Find<RadioButton>(n).IsEnabled = on;
            foreach (string n in new[] { "UrlInput", "EmailInput", "ClientIdInput", "CodeInput" }) Find<TextBox>(n).IsEnabled = on;
            foreach (string n in new[] { "MasterInput", "ClientSecretInput" }) Find<PasswordBox>(n).IsEnabled = on;
            Find<Button>("ModeLink").IsEnabled = on;
        }

        void SaveLocationOnly()
        {
            string err;
            string url = LocationUrl(out err);
            if (url == null) { ShowMsg(Find<TextBlock>("UrlError"), err, "Danger"); return; }
            string email = Find<TextBox>("EmailInput").Text.Trim();
            try
            {
                store.SaveConfig(url, apiKeyMode ? null : email);
                ShowMsg(Find<TextBlock>("SignInMessage"), "Saved. Open your AI app with the Bitwarden extension turned on, then come back here to sign in.", "Success");
            }
            catch (Exception e)
            {
                ShowMsg(Find<TextBlock>("SignInMessage"), "Couldn't save: " + e.Message, "Danger");
            }
        }

        /**
         * Signs in through the running server. `method` is -1 for "whatever the account asks",
         * otherwise the two-step method; `sendOnly` asks the server to email a code and stop.
         */
        public async void SignIn(int method, bool sendOnly)
        {
            Button signBtn = Find<Button>("SignInBtn"), sendBtn = Find<Button>("SendCodeBtn");
            if (IsBusy(signBtn) || IsBusy(sendBtn)) return;
            TextBlock msg = Find<TextBlock>("SignInMessage");
            HideMsg(msg);
            HideMsg(Find<TextBlock>("UrlError"));

            string err;
            string url = LocationUrl(out err);
            if (url == null) { ShowMsg(Find<TextBlock>("UrlError"), err, "Danger"); return; }
            string email = Find<TextBox>("EmailInput").Text.Trim();
            string clientId = Find<TextBox>("ClientIdInput").Text.Trim();
            PasswordBox master = Find<PasswordBox>("MasterInput");
            PasswordBox secret = Find<PasswordBox>("ClientSecretInput");
            if (!apiKeyMode && (email.Length == 0 || email.IndexOf('@') < 1))
            {
                ShowMsg(msg, "Enter the email you sign in to Bitwarden with.", "Danger");
                Find<TextBox>("EmailInput").Focus();
                return;
            }
            if (apiKeyMode && (clientId.Length == 0 || secret.Password.Length == 0))
            {
                ShowMsg(msg, "Enter your API key's client ID and client secret.", "Danger");
                return;
            }
            if (master.Password.Length == 0)
            {
                ShowMsg(msg, "Enter your master password.", "Danger");
                master.Focus();
                return;
            }
            if (twoStep && method < 0) method = SelectedMethod();
            string code = null;
            if (twoStep && !sendOnly && !apiKeyMode)
            {
                code = Find<TextBox>("CodeInput").Text.Trim();
                if (code.Length == 0)
                {
                    ShowMsg(msg, method == 1 ? "Enter the code from the email, or press \"Email me a code\" first." : "Enter your two-step login code.", "Danger");
                    Find<TextBox>("CodeInput").Focus();
                    return;
                }
            }

            // Remember where, so an extension that starts later already knows.
            try { store.SaveConfig(url, apiKeyMode ? null : email); } catch { }

            if (!CanTalk)
            {
                ShowMsg(msg, "Saved your vault address" + (apiKeyMode ? "" : " and email") + ". The extension isn't running, so signing in has to wait until you open your AI app.", "Warn");
                return;
            }

            Dictionary<string, object> req = new Dictionary<string, object>();
            req["op"] = apiKeyMode ? "login_apikey" : "login";
            req["serverUrl"] = url;
            if (apiKeyMode)
            {
                req["clientId"] = clientId;
                req["clientSecret"] = secret.Password;
            }
            else
            {
                req["email"] = email;
                if (method >= 0) req["method"] = method;
                if (code != null) req["code"] = code;
            }
            req["password"] = master.Password;

            Button b = sendOnly ? sendBtn : signBtn;
            SetBusy(b, sendOnly ? "Sending" : "Signing in");
            SetFormEnabled(false);
            string pipe = status.IpcPipe, token = status.IpcToken;
            IDictionary<string, object> res = null;
            string fail = null;
            try
            {
                res = await Task.Run(() => Ipc.Call(pipe, token, req, Ipc.LoginTimeout));
            }
            catch (IpcException e) { fail = e.Message; }
            catch (Exception e) { fail = e.Message; }
            finally
            {
                req.Clear();
                ClearBusy(b);
                SetFormEnabled(true);
            }
            if (fail != null)
            {
                ShowMsg(msg, "Couldn't reach the extension. " + fail, "Danger");
                return;
            }
            HandleLogin(res, url, email, method, sendOnly);
        }

        void HandleLogin(IDictionary<string, object> res, string url, string email, int method, bool sendOnly)
        {
            TextBlock msg = Find<TextBlock>("SignInMessage");
            string message = Json.Str(res, "message");
            if (Json.Bool(res, "ok") == true)
            {
                Find<PasswordBox>("MasterInput").Clear();
                Find<PasswordBox>("ClientSecretInput").Clear();
                Find<TextBox>("CodeInput").Text = "";
                twoStep = false;
                Show(Find<Border>("TwoStepPanel"), false);
                VaultInfo v = new VaultInfo();
                v.State = Json.Str(res, "state") ?? "unlocked";
                v.Email = Json.Str(res, "email") ?? (apiKeyMode ? null : email);
                v.ServerUrl = url;
                v.ServerHost = VaultUrl.Host(url);
                v.LastSync = DateTime.UtcNow;
                vault = v;
                HideMsg(msg);
                PaintAccount();
                PaintStatus();
                ShowMsg(Find<TextBlock>("AcctMessage"), v.State == "unlocked" ? "Signed in and unlocked. Your assistant can use your vault now." : "Signed in.", "Success");
                RefreshVault();
                return;
            }

            string error = Json.Str(res, "error") ?? "unknown";
            string text;
            switch (error)
            {
                case "code_required":
                    if (!twoStep)
                    {
                        twoStep = true;
                        Motion.Slide(Find<Border>("TwoStepPanel"), true, -8);
                    }
                    if (method == 1) Find<RadioButton>("MethodEmail").IsChecked = true;
                    PaintMethod();
                    text = !string.IsNullOrEmpty(message) ? message : method == 1 ? "We've emailed you a code. Enter it above." : "Enter your two-step login code above.";
                    ShowMsg(msg, text, sendOnly ? "Success" : "Muted");
                    Find<TextBox>("CodeInput").Focus();
                    return;
                case "bad_password":
                    Find<PasswordBox>("MasterInput").Clear();
                    text = "That master password wasn't accepted. Check it and try again.";
                    Find<PasswordBox>("MasterInput").Focus();
                    break;
                case "bad_code":
                    text = "That code wasn't accepted. Check it, or get a new one, and try again.";
                    Find<TextBox>("CodeInput").SelectAll();
                    Find<TextBox>("CodeInput").Focus();
                    break;
                case "network": text = "Couldn't reach your vault at " + VaultUrl.Host(url) + ". Check the address and your connection."; break;
                case "invalid_url": text = "The extension didn't accept that address."; break;
                case "fixed_url": text = "This install's vault address is fixed by its configuration, so it can't be changed here."; break;
                case "signed_in_elsewhere": text = "Already signed in to a different account or server. Sign out first."; break;
                case "busy": text = "The extension is busy with another request. Try again in a moment."; break;
                case "rate_limited": text = "Too many attempts. Wait a few minutes and try again."; break;
                case "unavailable": text = "Signing in isn't available right now."; break;
                default: text = "Sign-in didn't work."; break;
            }
            if (!string.IsNullOrEmpty(message)) text = message;
            ShowMsg(msg, text, "Danger");
        }

        async void Unlock()
        {
            Button b = Find<Button>("UnlockBtn");
            PasswordBox pb = Find<PasswordBox>("UnlockPassword");
            TextBlock msg = Find<TextBlock>("AcctMessage");
            if (IsBusy(b) || !CanTalk) return;
            if (pb.Password.Length == 0) { ShowMsg(msg, "Enter your master password.", "Danger"); pb.Focus(); return; }
            Dictionary<string, object> req = new Dictionary<string, object>();
            req["op"] = "unlock";
            req["password"] = pb.Password;
            pb.Clear();
            SetBusy(b, "Unlocking");
            string pipe = status.IpcPipe, token = status.IpcToken;
            IDictionary<string, object> res = null;
            string fail = null;
            try { res = await Task.Run(() => Ipc.Call(pipe, token, req, Ipc.LoginTimeout)); }
            catch (Exception e) { fail = e.Message; }
            finally { req.Clear(); ClearBusy(b); }
            if (fail != null) { ShowMsg(msg, "Couldn't reach the extension. " + fail, "Danger"); return; }
            if (Json.Bool(res, "ok") == true)
            {
                if (vault != null) vault.State = "unlocked";
                PaintAccount();
                ShowMsg(msg, "Unlocked.", "Success");
                RefreshVault();
            }
            else
            {
                string m = Json.Str(res, "message");
                ShowMsg(msg, !string.IsNullOrEmpty(m) ? m : Json.Str(res, "error") == "bad_password" ? "That master password wasn't accepted." : "Couldn't unlock the vault.", "Danger");
                pb.Focus();
            }
        }

        async void LockVault(Button b)
        {
            if (IsBusy(b)) return;
            TextBlock msg = Find<TextBlock>("AcctMessage");
            if (!CanTalk)
            {
                Ask("The extension isn't running", "There's nothing to lock right now: the vault locks when the extension stops, unless you chose Never.", "OK", false, null, null);
                return;
            }
            SetBusy(b, "Locking");
            string pipe = status.IpcPipe, token = status.IpcToken;
            Dictionary<string, object> req = new Dictionary<string, object>();
            req["op"] = "lock";
            IDictionary<string, object> res = null;
            string fail = null;
            try { res = await Task.Run(() => Ipc.Call(pipe, token, req, Ipc.ShortTimeout)); }
            catch (Exception e) { fail = e.Message; }
            finally { ClearBusy(b); }
            if (fail == null && Json.Bool(res, "ok") == true)
            {
                if (vault != null && vault.SignedIn) vault.State = "locked";
                PaintAccount();
                ShowMsg(msg, "Locked. The assistant has to ask you to unlock it again.", "Success");
                RefreshVault();
            }
            else ShowMsg(msg, "Couldn't lock the vault. " + (fail ?? Json.Str(res, "message") ?? ""), "Danger");
        }

        async void SignOut()
        {
            Button b = Find<Button>("SignOutBtn");
            TextBlock msg = Find<TextBlock>("AcctMessage");
            if (IsBusy(b) || !CanTalk) return;
            SetBusy(b, "Signing out");
            string pipe = status.IpcPipe, token = status.IpcToken;
            Dictionary<string, object> req = new Dictionary<string, object>();
            req["op"] = "logout";
            IDictionary<string, object> res = null;
            string fail = null;
            try { res = await Task.Run(() => Ipc.Call(pipe, token, req, Ipc.LoginTimeout)); }
            catch (Exception e) { fail = e.Message; }
            finally { ClearBusy(b); }
            if (fail == null && Json.Bool(res, "ok") == true)
            {
                if (vault != null) vault.State = "unauthenticated";
                twoStep = false;
                Show(Find<Border>("TwoStepPanel"), false);
                FillSignInFromConfig();
                PaintAccount();
                ShowMsg(msg, "Signed out.", "Success");
                RefreshVault();
            }
            else ShowMsg(msg, "Couldn't sign out. " + (fail ?? Json.Str(res, "message") ?? ""), "Danger");
        }

        // =====================================================================================
        // Updates
        // =====================================================================================

        string Installed
        {
            get { return status != null && Updater.ValidTag(status.Version) ? Updater.Clean(status.Version) : AppInfo.Version; }
        }

        /** What is known about the newest release: our cache, or the server's own check. */
        UpdateInfo Known
        {
            get
            {
                UpdateInfo u = update;
                if (status != null && Updater.ValidTag(status.UpdateLatest) && (u == null || Updater.Compare(status.UpdateLatest, u.Latest) > 0))
                {
                    u = new UpdateInfo();
                    u.Latest = Updater.Clean(status.UpdateLatest);
                    u.Url = Updater.TrustedPage(status.UpdateUrl) ? status.UpdateUrl : Updater.ReleasesPage;
                    u.CheckedAt = status.UpdatedAt.HasValue ? status.UpdatedAt.Value : DateTime.UtcNow;
                }
                return u;
            }
        }

        bool UpdateAvailable { get { UpdateInfo u = Known; return u != null && Updater.IsNewer(u.Latest, Installed); } }

        void PaintUpdates()
        {
            UpdateInfo u = Known;
            Find<TextBlock>("ExtVersion").Text = status != null && !string.IsNullOrEmpty(status.Version) ? status.Version : "Not installed yet";
            Border box = Find<Border>("UpdIconBox");
            TextBlock icon = Find<TextBlock>("UpdIcon"), title = Find<TextBlock>("UpdTitle"), sub = Find<TextBlock>("UpdSub");
            string when = u != null && u.CheckedAt > DateTime.MinValue ? "checked " + Ago(u.CheckedAt) : "not checked yet";
            Button install = Find<Button>("UpdateBtn");
            if (UpdateAvailable)
            {
                box.SetResourceReference(Border.BackgroundProperty, "AccentSoft");
                icon.SetResourceReference(TextBlock.ForegroundProperty, "Accent");
                icon.Text = ((char)0xE896).ToString();
                title.Text = "Version " + u.Latest + " is available";
                sub.Text = "You have " + Installed + Ch.Dot + when;
                if (!IsBusy(install)) install.Content = status != null && status.IsClaudeDesktop ? "Download and install" : "Open the release page";
                Show(Find<WrapPanel>("UpdActions"), true);
            }
            else
            {
                box.SetResourceReference(Border.BackgroundProperty, "SuccessSoft");
                icon.SetResourceReference(TextBlock.ForegroundProperty, "Success");
                icon.Text = ((char)0xE73E).ToString();
                title.Text = checking ? "Checking for updates" + Ch.Ellipsis : "You're up to date";
                sub.Text = "Version " + Installed + Ch.Dot + when;
                Show(Find<WrapPanel>("UpdActions"), false);
            }
        }

        void PaintUpdateBanner()
        {
            Border banner = Find<Border>("UpdateBanner");
            bool show = UpdateAvailable && !inWelcome && page != "updates";
            if (show)
            {
                Find<TextBlock>("UpdateBannerText").Text = "Bitwarden MCP " + Known.Latest + " is available. You have " + Installed + ". Updates include security fixes.";
                if (banner.Visibility != Visibility.Visible) Motion.Slide(banner, true, -10);
            }
            else banner.Visibility = Visibility.Collapsed;
        }

        async void CheckUpdates(bool manual)
        {
            if (checking || still) return;
            checking = true;
            Button b = Find<Button>("CheckBtn");
            SetBusy(b, "Checking");
            HideMsg(Find<TextBlock>("UpdMessage"));
            PaintUpdates();
            UpdateInfo got = null;
            string fail = null;
            try { got = await Task.Run(() => Updater.Fetch()); }
            catch (Exception e) { fail = Friendly(e); }
            checking = false;
            ClearBusy(b);
            if (got != null)
            {
                update = got;
                store.SaveUpdateCache(got);
            }
            else if (fail == null) fail = "GitHub didn't return a usable release.";
            if (manual && fail != null) ShowMsg(Find<TextBlock>("UpdMessage"), "Couldn't check for updates. " + fail, "Danger");
            else if (manual && !UpdateAvailable) ShowMsg(Find<TextBlock>("UpdMessage"), "You have the latest version.", "Success");
            PaintUpdates();
            PaintUpdateBanner();
        }

        static string Friendly(Exception e)
        {
            WebException w = e as WebException;
            if (w != null && w.Status == WebExceptionStatus.NameResolutionFailure) return "You seem to be offline.";
            if (w != null && w.Response is HttpWebResponse && (int)((HttpWebResponse)w.Response).StatusCode == 403) return "GitHub is limiting requests from your network. Try again in an hour.";
            return e.Message;
        }

        async void InstallUpdate()
        {
            Button b = Find<Button>("UpdateBtn");
            TextBlock msg = Find<TextBlock>("UpdMessage");
            if (downloading || IsBusy(b)) return;
            UpdateInfo u = Known;
            if (u == null) return;

            // Only Claude Desktop installs from a downloaded bundle. Everything else updates by
            // re-running setup from the new release, so the page is the useful thing to open.
            if (status == null || !status.IsClaudeDesktop)
            {
                Open(Updater.TrustedPage(u.Url) ? u.Url : Updater.ReleasesPage);
                ShowMsg(msg, "The release page is open in your browser. Installs made with the setup script update by running it again from the new release.", "Muted");
                return;
            }

            downloading = true;
            SetBusy(b, "Downloading");
            HideMsg(msg);
            StackPanel prog = Find<StackPanel>("UpdProgress");
            Border fill = Find<Border>("UpdFill"), track = Find<Border>("UpdTrack");
            TextBlock progText = Find<TextBlock>("UpdProgressText");
            fill.BeginAnimation(FrameworkElement.WidthProperty, null);
            fill.Width = 0;
            Motion.Slide(prog, true, -6);
            progText.Text = "Contacting GitHub" + Ch.Ellipsis;
            System.Net.WebClient wc = null;
            string part = null;
            try
            {
                if (u.McpbUrl == null || u.SumsUrl == null || u.McpbName == null)
                {
                    UpdateInfo fresh = await Task.Run(() => Updater.Fetch());
                    if (fresh != null) { update = fresh; store.SaveUpdateCache(fresh); u = fresh; }
                }
                if (u.McpbUrl == null || u.SumsUrl == null || u.McpbName == null)
                    throw new InvalidDataException("This release has no installable bundle. The release page has the details.");

                Directory.CreateDirectory(store.UpdatesDir);
                string target = Path.Combine(store.UpdatesDir, u.McpbName);
                part = target + ".part";
                wc = Updater.Client();
                string sums = await wc.DownloadStringTaskAsync(new Uri(u.SumsUrl));
                Dictionary<string, string> map = Updater.ParseSums(sums);
                string want;
                if (!map.TryGetValue(u.McpbName, out want)) throw new InvalidDataException("The release's checksum list doesn't include " + u.McpbName + ".");

                wc.DownloadProgressChanged += delegate(object s, System.Net.DownloadProgressChangedEventArgs e)
                {
                    double frac = e.TotalBytesToReceive > 0 ? (double)e.BytesReceived / e.TotalBytesToReceive : 0;
                    Motion.To(fill, FrameworkElement.WidthProperty, Math.Max(6, track.ActualWidth * frac), 160);
                    progText.Text = "Downloading " + (e.BytesReceived / 1048576.0).ToString("0.0", CultureInfo.InvariantCulture) + " of " + (e.TotalBytesToReceive / 1048576.0).ToString("0.0", CultureInfo.InvariantCulture) + " MB";
                };
                await wc.DownloadFileTaskAsync(new Uri(u.McpbUrl), part);
                progText.Text = "Checking the download" + Ch.Ellipsis;
                string localPart = part;
                string got = await Task.Run(() => Updater.Sha256(localPart));
                if (got != want)
                {
                    try { File.Delete(part); } catch { }
                    throw new InvalidDataException("The download didn't match its published checksum, so it was deleted. Try again later.");
                }
                if (File.Exists(target)) File.Delete(target);
                File.Move(part, target);
                part = null;
                Motion.To(fill, FrameworkElement.WidthProperty, track.ActualWidth, 160);
                progText.Text = "Downloaded and verified.";
                Process.Start(new ProcessStartInfo(target) { UseShellExecute = true });
                ShowMsg(msg, "Claude Desktop will open its install window. Click Install to finish.", "Success");
            }
            catch (Exception e)
            {
                ShowMsg(msg, "The update couldn't be installed. " + Friendly(e), "Danger");
                Motion.Slide(prog, false, -6);
                if (part != null) { try { File.Delete(part); } catch { } }
            }
            finally
            {
                downloading = false;
                ClearBusy(b);
                if (wc != null) wc.Dispose();
            }
        }

        // =====================================================================================
        // Activity
        // =====================================================================================

        void LoadActivity()
        {
            StackPanel list = Find<StackPanel>("ActivityList");
            list.Children.Clear();
            List<ActivityEntry> entries;
            try { entries = Activity.Read(store.LogFile, 300); }
            catch { entries = new List<ActivityEntry>(); }
            Find<TextBlock>("ActivityCount").Text = entries.Count == 0 ? "No recent activity" : entries.Count == 1 ? "1 recent event" : entries.Count + " recent events";
            Show(Find<TextBlock>("ActivityEmpty"), entries.Count == 0);
            DateTime lastDay = DateTime.MinValue;
            foreach (ActivityEntry e in entries)
            {
                DateTime local = e.When.ToLocalTime();
                if (local.Date != lastDay)
                {
                    lastDay = local.Date;
                    TextBlock day = new TextBlock();
                    day.Text = local.Date == DateTime.Today ? "Today" : local.Date == DateTime.Today.AddDays(-1) ? "Yesterday" : local.ToString("dddd, d MMMM yyyy", CultureInfo.CurrentCulture);
                    day.FontSize = 12;
                    day.FontWeight = FontWeights.SemiBold;
                    day.Margin = new Thickness(12, list.Children.Count == 0 ? 2 : 14, 0, 6);
                    day.SetResourceReference(TextBlock.ForegroundProperty, "Muted");
                    list.Children.Add(day);
                }
                Grid row = new Grid();
                row.Margin = new Thickness(4, 0, 4, 2);
                row.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
                row.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
                row.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
                Border ic = new Border();
                ic.Width = 30;
                ic.Height = 30;
                ic.CornerRadius = new CornerRadius(15);
                ic.Margin = new Thickness(8, 4, 12, 4);
                ic.SetResourceReference(Border.BackgroundProperty, "Surface2");
                TextBlock g = new TextBlock();
                g.FontFamily = (FontFamily)Window.FindResource("Icons");
                g.FontSize = 13;
                g.Text = ((char)Convert.ToInt32(e.Glyph, 16)).ToString();
                g.HorizontalAlignment = HorizontalAlignment.Center;
                g.VerticalAlignment = VerticalAlignment.Center;
                g.SetResourceReference(TextBlock.ForegroundProperty, "Muted");
                ic.Child = g;
                row.Children.Add(ic);
                TextBlock t = new TextBlock();
                t.Text = e.Text;
                t.TextWrapping = TextWrapping.Wrap;
                t.VerticalAlignment = VerticalAlignment.Center;
                t.SetResourceReference(TextBlock.ForegroundProperty, "Fg");
                Grid.SetColumn(t, 1);
                row.Children.Add(t);
                TextBlock time = new TextBlock();
                time.Text = local.ToString("t", CultureInfo.CurrentCulture);
                time.FontSize = 12;
                time.Margin = new Thickness(12, 0, 10, 0);
                time.VerticalAlignment = VerticalAlignment.Center;
                time.SetResourceReference(TextBlock.ForegroundProperty, "Muted");
                Grid.SetColumn(time, 2);
                row.Children.Add(time);
                list.Children.Add(row);
            }
        }

        // =====================================================================================
        // Shortcuts
        // =====================================================================================

        bool AddShortcut(bool desktop, bool report)
        {
            TextBlock msg = Find<TextBlock>("ShortcutMsg");
            try
            {
                string target = Shortcuts.Target(store);
                string dir = desktop ? Shortcuts.Desktop : Shortcuts.StartMenu;
                Shortcuts.Create(dir, target);
                if (desktop) Shortcuts.RemoveLegacy(dir);
                if (report) ShowMsg(msg, desktop ? "Added to your desktop." : "Added to the Start menu.", "Success");
                return true;
            }
            catch (Exception e)
            {
                if (report) ShowMsg(msg, "Couldn't add the shortcut. " + e.Message, "Danger");
                return false;
            }
        }

        // =====================================================================================
        // Welcome
        // =====================================================================================

        void Borrow(FrameworkElement el, Decorator host)
        {
            Panel parent = el.Parent as Panel;
            if (parent == null) return;
            Borrowed b = new Borrowed();
            b.Element = el;
            b.Parent = parent;
            b.Index = parent.Children.IndexOf(el);
            b.Host = host;
            parent.Children.Remove(el);
            host.Child = el;
            borrowed.Add(b);
        }

        void ReturnBorrowed()
        {
            for (int i = borrowed.Count - 1; i >= 0; i--)
            {
                Borrowed b = borrowed[i];
                b.Host.Child = null;
                b.Parent.Children.Insert(Math.Min(b.Index, b.Parent.Children.Count), b.Element);
            }
            borrowed.Clear();
        }

        void BuildDots()
        {
            StackPanel dots = Find<StackPanel>("StepDots");
            for (int i = 0; i < 4; i++)
            {
                Border d = new Border();
                d.Height = 8;
                d.Width = 8;
                d.CornerRadius = new CornerRadius(4);
                d.Margin = new Thickness(0, 0, 6, 0);
                d.SetResourceReference(Border.BackgroundProperty, "LineStrong");
                dots.Children.Add(d);
            }
        }

        public void ShowWelcome(int step)
        {
            if (!inWelcome)
            {
                inWelcome = true;
                Borrow(Find<StackPanel>("LocationPanel"), Find<Border>("WLocHost"));
                Borrow(Find<StackPanel>("CredsPanel"), Find<Border>("WCredsHost"));
                Borrow(Find<Border>("AccessCard"), Find<Border>("WAccessHost"));
                Borrow(Find<Border>("ChangesCard"), Find<Border>("WChangesHost"));
                Show(Find<Border>("CredsDivider"), false);
                Grid w = Find<Grid>("Welcome");
                w.Visibility = Visibility.Visible;
                if (Motion.On) w.BeginAnimation(UIElement.OpacityProperty, new System.Windows.Media.Animation.DoubleAnimation(0, 1, new Duration(TimeSpan.FromMilliseconds(220))));
                PaintStatus();
            }
            GoStep(Math.Max(1, Math.Min(4, step)));
        }

        void GoStep(int n)
        {
            welcomeStep = n;
            for (int i = 1; i <= 4; i++) Show(Find<StackPanel>("WStep" + i), i == n);
            Motion.Enter(Find<StackPanel>("WStep" + n), 14);
            Find<ScrollViewer>("WelcomeScroller").ScrollToVerticalOffset(0);
            StackPanel dots = Find<StackPanel>("StepDots");
            for (int i = 0; i < dots.Children.Count; i++)
            {
                Border d = (Border)dots.Children[i];
                Motion.To(d, FrameworkElement.WidthProperty, i == n - 1 ? 26 : 8, 200);
                d.SetResourceReference(Border.BackgroundProperty, i < n ? "Accent" : "LineStrong");
            }
            PaintAccount();
            PaintWelcomeButtons();
            if (n == 2) RefreshVault();
        }

        void PaintWelcomeButtons()
        {
            Show(Find<Button>("WBack"), welcomeStep > 1);
            bool signedIn = vault != null && vault.SignedIn;
            bool skip = welcomeStep == 2 && !signedIn;
            Button next = Find<Button>("WNext");
            next.Content = welcomeStep == 4 ? "Finish" : skip ? "Skip for now" : "Continue";
            // While the form has its own Sign in button, skipping must not look like the main action.
            next.Style = (Style)Window.FindResource(skip ? "Btn" : "PrimaryBtn");
            Show(Find<Button>("SkipWelcome"), welcomeStep < 4);
            if (welcomeStep == 2)
            {
                string err;
                string url = LocationUrl(out err);
                Find<TextBlock>("WSignInDesc").Text = (url == null ? "" : "Signing in to " + VaultUrl.Host(url) + ". ") + "Your master password goes straight to the Bitwarden command-line tool on this computer. It's never saved, and your assistant never sees it.";
            }
        }

        void WelcomeNext()
        {
            if (welcomeStep == 1)
            {
                string err;
                string url = LocationUrl(out err);
                if (url == null) { ShowMsg(Find<TextBlock>("UrlError"), err, "Danger"); return; }
                try { store.SaveConfig(url, null); } catch { }
                GoStep(2);
            }
            else if (welcomeStep == 2)
            {
                string email = Find<TextBox>("EmailInput").Text.Trim();
                if (email.Length > 0 && !apiKeyMode) { try { store.SaveConfig(null, email); } catch { } }
                GoStep(3);
            }
            else if (welcomeStep == 3) GoStep(4);
            else FinishWelcome();
        }

        void FinishWelcome()
        {
            if (!Save()) return;
            if (Find<CheckBox>("WDesktop").IsChecked == true) AddShortcut(true, false);
            if (Find<CheckBox>("WStartMenu").IsChecked == true) AddShortcut(false, false);
            CloseWelcome();
            Navigate("account", true);
        }

        void SkipWelcome()
        {
            // Saving pins the defaults, so the welcome screen doesn't come back every launch.
            if (!File.Exists(store.SettingsFile)) Save();
            CloseWelcome();
            Navigate("account", true);
        }

        void CloseWelcome()
        {
            if (!inWelcome) return;
            ReturnBorrowed();
            Show(Find<Border>("CredsDivider"), true);
            Find<Grid>("Welcome").Visibility = Visibility.Collapsed;
            inWelcome = false;
            PaintStatus();
            PaintFooter();
            PlacePill(false);
        }

        public bool ShouldWelcome()
        {
            if (File.Exists(store.SettingsFile)) return false;
            return status == null || status.Vault == null || !status.Vault.SignedIn;
        }

        // =====================================================================================
        // Launch requests from the server
        // =====================================================================================

        public void OpenRequested(string requested)
        {
            if (requested == null) return;
            if (requested == "welcome") ShowWelcome(1);
            else if (!inWelcome) Navigate(requested, true);
        }

        void HandleLaunchRequest()
        {
            string p = store.TakeLaunchRequest();
            if (p == null) return;
            BringToFront();
            OpenRequested(p);
        }

        [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr h);

        void BringToFront()
        {
            if (Window.WindowState == WindowState.Minimized) Window.WindowState = WindowState.Normal;
            Window.Activate();
            Window.Topmost = true;
            Window.Topmost = false;
            try { SetForegroundWindow(new WindowInteropHelper(Window).Handle); } catch { }
        }

        // =====================================================================================
        // In-window dialog
        // =====================================================================================

        /** done(1) for the main button, 2 for the alternative, 0 for cancel. */
        void Ask(string title, string text, string ok, bool danger, string alt, Action<int> done)
        {
            Find<TextBlock>("DlgTitle").Text = title;
            Find<TextBlock>("DlgText").Text = text;
            Button okBtn = Find<Button>("DlgOk");
            okBtn.Content = ok;
            okBtn.Style = (Style)Window.FindResource(danger ? "DangerBtn" : "PrimaryBtn");
            Button altBtn = Find<Button>("DlgAlt");
            altBtn.Content = alt ?? "";
            Show(altBtn, alt != null);
            Show(Find<Button>("DlgCancel"), done != null);
            dialogDone = done;
            Grid layer = Find<Grid>("DialogLayer");
            layer.Visibility = Visibility.Visible;
            if (Motion.On) layer.BeginAnimation(UIElement.OpacityProperty, new System.Windows.Media.Animation.DoubleAnimation(0, 1, new Duration(TimeSpan.FromMilliseconds(150))));
            Motion.Pop(Find<Border>("DialogCard"));
            okBtn.Focus();
        }

        void CloseDialog(int r)
        {
            Find<Grid>("DialogLayer").Visibility = Visibility.Collapsed;
            Action<int> d = dialogDone;
            dialogDone = null;
            if (d != null) d(r);
        }

        // =====================================================================================
        // Off-screen rendering, for docs and for the self-test
        // =====================================================================================

        void Offscreen()
        {
            Window.WindowStartupLocation = WindowStartupLocation.Manual;
            Window.Left = -30000;
            Window.Top = -30000;
            Window.ShowActivated = false;
            Window.ShowInTaskbar = false;
        }

        public void ShowOffscreen()
        {
            Offscreen();
            Window.Show();
            Window.UpdateLayout();
        }

        public void Screenshot(string file, int height, double scale, double scroll)
        {
            if (height > 0) Window.Height = height;
            Offscreen();
            closingConfirmed = true;
            Window.ContentRendered += delegate
            {
                Window.Dispatcher.BeginInvoke(DispatcherPriority.ApplicationIdle, new Action(delegate
                {
                    if (scroll > 0) Find<ScrollViewer>(inWelcome ? "WelcomeScroller" : "Scroller").ScrollToVerticalOffset(scroll);
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
                        Window.Close();
                    }));
                }));
            };
        }

        // =====================================================================================
        // Hooks for the self-test
        // =====================================================================================

        public SettingsModel Model { get { Collect(); return model; } }
        public void TypeSite(string text) { Find<TextBox>("SiteInput").Text = text; AddSite(); }
        public string SiteError { get { TextBlock t = Find<TextBlock>("SiteError"); return t.Visibility == Visibility.Visible ? t.Text : null; } }
        public void Choose(string radio) { Find<RadioButton>(radio).IsChecked = true; }
        public void Toggle(string box, bool on) { Find<CheckBox>(box).IsChecked = on; }
        public bool IsEnabled(string name) { return ((UIElement)Window.FindName(name)).IsEnabled; }
        public bool IsShown(string name) { UIElement u = Window.FindName(name) as UIElement; return u != null && u.Visibility == Visibility.Visible; }
        public void Pill(string panel, int value) { SelectPill(panel, panel, value, delegate(int v) { return v.ToString(CultureInfo.InvariantCulture); }); }
        public bool IsDirty { get { return Dirty(); } }
        public string BannerShown { get { Border b = Find<Border>("Banner"); return b.Visibility == Visibility.Visible ? Find<TextBlock>("BannerText").Text : null; } }
        public void SetText(string box, string text) { Find<TextBox>(box).Text = text; }
        public void SetPassword(string box, string text) { Find<PasswordBox>(box).Password = text; }
        public string Password(string box) { return Find<PasswordBox>(box).Password; }
        public string Text(string block) { return Find<TextBlock>(block).Text; }
        public string State { get { return vault != null ? vault.State : null; } }
        public bool AnyBusy { get { return busy.Count > 0; } }
        public string Page { get { return page; } }
        public bool InWelcome { get { return inWelcome; } }
        public int WelcomeStep { get { return welcomeStep; } }
        public void ClickWelcomeNext() { WelcomeNext(); }

        /** For documentation screenshots: the sign-in form at its two-step stage. */
        public void ShowTwoStepForDocs()
        {
            twoStep = true;
            Show(Find<Border>("TwoStepPanel"), true);
            Find<RadioButton>("MethodEmail").IsChecked = true;
            PaintMethod();
            ShowMsg(Find<TextBlock>("SignInMessage"), "We've emailed you a code. Enter it above.", "Success");
        }

        public List<string> ContrastFailures()
        {
            Window.UpdateLayout();
            Color pageColor = ((SolidColorBrush)Window.FindResource("Page")).Color;
            return Contrast.Failures(Window, pageColor, 3.0);
        }

        public void SetTheme(bool d)
        {
            Theme.Apply(Window.Resources, d);
        }
    }
}
