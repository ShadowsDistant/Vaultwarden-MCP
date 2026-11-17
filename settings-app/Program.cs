// Bitwarden MCP Settings
// Copyright (C) 2026 ShadowsDistant. Licensed under the GNU GPL v3 or later.
//
// Entry point. Written to compile with either the Roslyn csc that ships with Visual Studio Build
// Tools or the C# 5 compiler in every .NET Framework 4.x install, so it uses no newer syntax.

using System;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Threading;
using System.Windows;

[assembly: AssemblyTitle("Bitwarden MCP Settings")]
[assembly: AssemblyProduct("Bitwarden MCP")]
[assembly: AssemblyCopyright("Copyright (C) 2026 ShadowsDistant. GPL-3.0-or-later.")]

namespace BitwardenMcpSettings
{
    static class Program
    {
        [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr h);
        [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr h, int cmd);

        [STAThread]
        static int Main(string[] args)
        {
            string home = null, shot = null, theme = null, page = null;
            bool selftest = false;
            int height = 0, step = 1;
            double scale = 1, scroll = 0;
            for (int i = 0; i < args.Length; i++)
            {
                string a = args[i];
                string next = i + 1 < args.Length ? args[i + 1] : null;
                if (a == "--home" && next != null) { home = next; i++; }
                else if (a == "--screenshot" && next != null) { shot = next; i++; }
                else if (a == "--theme" && next != null) { theme = next == "dark" || next == "light" ? next : null; i++; }
                else if (a == "--page" && next != null) { page = next.ToLowerInvariant(); i++; }
                else if (a == "--step" && next != null) { int.TryParse(next, out step); i++; }
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
                single = new Mutex(true, "Local\\BitwardenMcpSettings", out created);
                if (!created)
                {
                    // Already open. The first window watches launch-request.json for the server's
                    // requests; for a double-click on a shortcut, bring it forward from here.
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
            MainController ctl = new MainController(home, theme, shot != null);
            Store store = new Store(home);
            if (shot != null)
            {
                if (page == "welcome") ctl.ShowWelcome(step);
                else if (page != null) ctl.Navigate(page, false);
                if (page == "account" && step == 2) ctl.ShowTwoStepForDocs();
                ctl.Screenshot(Path.GetFullPath(shot), height, scale, scroll);
            }
            else
            {
                string requested = page ?? store.TakeLaunchRequest();
                if (requested == null && ctl.ShouldWelcome()) requested = "welcome";
                if (requested != null) ctl.OpenRequested(requested);
            }
            int code = app.Run(ctl.Window);
            GC.KeepAlive(single);
            return code;
        }
    }
}
