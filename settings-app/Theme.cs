// Bitwarden MCP Settings
// Copyright (C) 2026 ShadowsDistant. Licensed under the GNU GPL v3 or later.
//
// The palette, the motion helpers, and the contrast check the self-test runs over every page.

using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Interop;
using System.Windows.Media;
using System.Windows.Media.Animation;
using System.Windows.Shapes;
using Microsoft.Win32;

namespace BitwardenMcpSettings
{
    public static class Theme
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

        public static bool Resolve(string mode)
        {
            if (mode == "dark") return true;
            if (mode == "light") return false;
            return SystemIsDark();
        }

        static Color C(string hex, byte alpha)
        {
            Color c = (Color)ColorConverter.ConvertFromString(hex);
            c.A = alpha;
            return c;
        }

        static Color C(string hex) { return (Color)ColorConverter.ConvertFromString(hex); }

        /** Every brush the window uses, by name. Nothing else in the app picks a colour. */
        public static Dictionary<string, Color> Palette(bool dark)
        {
            Dictionary<string, Color> p = new Dictionary<string, Color>();
            if (dark)
            {
                p["Page"] = C("#1c1c1a");
                p["Nav"] = C("#20201e");
                p["Surface"] = C("#272725");
                p["Surface2"] = C("#2f2f2c");
                p["Surface3"] = C("#3b3b38");
                p["Hover"] = C("#ffffff", 0x12);
                p["Fg"] = C("#f3f2ed");
                p["Muted"] = C("#b4b2aa");
                p["Faint"] = C("#8f8d86");
                p["Line"] = C("#363633");
                p["LineStrong"] = C("#4b4a46");
                p["Accent"] = C("#7ab0ff");
                p["AccentFg"] = C("#0b1f3d");
                p["AccentSoft"] = C("#7ab0ff", 0x22);
                p["AccentLine"] = C("#7ab0ff", 0x55);
                p["Link"] = C("#8fbdff");
                p["Danger"] = C("#f28b82");
                p["DangerSoft"] = C("#f28b82", 0x22);
                p["DangerFill"] = C("#f28b82");
                p["DangerFg"] = C("#3a0d09");
                p["Success"] = C("#6fd0a0");
                p["SuccessSoft"] = C("#6fd0a0", 0x22);
                p["SuccessLine"] = C("#6fd0a0", 0x55);
                p["Warn"] = C("#e6ba6a");
                p["WarnSoft"] = C("#e6ba6a", 0x1c);
                p["WarnLine"] = C("#e6ba6a", 0x55);
                p["Scrim"] = C("#000000", 0xa0);
            }
            else
            {
                p["Page"] = C("#f3f2ee");
                p["Nav"] = C("#eceae4");
                p["Surface"] = C("#fcfbf8");
                p["Surface2"] = C("#f5f4ef");
                p["Surface3"] = C("#e5e3db");
                p["Hover"] = C("#000000", 0x0c);
                p["Fg"] = C("#161615");
                p["Muted"] = C("#5f5e5a");
                p["Faint"] = C("#83827c");
                p["Line"] = C("#e2e0d7");
                p["LineStrong"] = C("#cbc8bd");
                p["Accent"] = C("#2f6fe0");
                p["AccentFg"] = C("#ffffff");
                p["AccentSoft"] = C("#2f6fe0", 0x14);
                p["AccentLine"] = C("#2f6fe0", 0x40);
                p["Link"] = C("#285fc4");
                p["Danger"] = C("#b3261e");
                p["DangerSoft"] = C("#b3261e", 0x16);
                p["DangerFill"] = C("#c4372e");
                p["DangerFg"] = C("#ffffff");
                p["Success"] = C("#1b7748");
                p["SuccessSoft"] = C("#1b7748", 0x18);
                p["SuccessLine"] = C("#1b7748", 0x40);
                p["Warn"] = C("#8a560c");
                p["WarnSoft"] = C("#e0a040", 0x22);
                p["WarnLine"] = C("#8a560c", 0x44);
                p["Scrim"] = C("#000000", 0x60);
            }
            return p;
        }

        public static void Apply(ResourceDictionary r, bool dark)
        {
            foreach (KeyValuePair<string, Color> kv in Palette(dark))
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
                if (h == IntPtr.Zero) return;
                int on = dark ? 1 : 0;
                // 20 is DWMWA_USE_IMMERSIVE_DARK_MODE on Windows 10 2004 and later; 19 before that.
                if (DwmSetWindowAttribute(h, 20, ref on, 4) != 0) DwmSetWindowAttribute(h, 19, ref on, 4);
                // Windows 11: round the corners and let the caption take the page colour.
                int round = 2;
                DwmSetWindowAttribute(h, 33, ref round, 4);
                Color page = Palette(dark)["Page"];
                int bgr = page.R | (page.G << 8) | (page.B << 16);
                DwmSetWindowAttribute(h, 35, ref bgr, 4);
            }
            catch { }
        }
    }

    // -----------------------------------------------------------------------------------------
    // Motion. Everything here checks Motion.On, so "Off" means off.
    // -----------------------------------------------------------------------------------------

    public static class Motion
    {
        public static bool On = true;

        public static readonly IEasingFunction Out = MakeOut();

        static IEasingFunction MakeOut()
        {
            CubicEase e = new CubicEase();
            e.EasingMode = EasingMode.EaseOut;
            e.Freeze();
            return e;
        }

        static Duration D(int ms) { return new Duration(TimeSpan.FromMilliseconds(On ? ms : 0)); }

        static TranslateTransform Translate(UIElement el)
        {
            TranslateTransform t = el.RenderTransform as TranslateTransform;
            if (t == null || t.IsFrozen)
            {
                t = new TranslateTransform();
                el.RenderTransform = t;
            }
            return t;
        }

        /** Fade in while rising a few pixels. Used for pages and welcome steps. */
        public static void Enter(UIElement el, double fromY)
        {
            TranslateTransform t = Translate(el);
            if (!On)
            {
                el.BeginAnimation(UIElement.OpacityProperty, null);
                t.BeginAnimation(TranslateTransform.YProperty, null);
                el.Opacity = 1;
                t.Y = 0;
                return;
            }
            DoubleAnimation fade = new DoubleAnimation(0, 1, D(200));
            fade.EasingFunction = Out;
            DoubleAnimation rise = new DoubleAnimation(fromY, 0, D(220));
            rise.EasingFunction = Out;
            el.BeginAnimation(UIElement.OpacityProperty, fade);
            t.BeginAnimation(TranslateTransform.YProperty, rise);
        }

        /** Slides an element into view from below (positive dy) or above, or back out of it. */
        public static void Slide(UIElement el, bool show, double dy)
        {
            TranslateTransform t = Translate(el);
            if (show)
            {
                el.Visibility = Visibility.Visible;
                if (!On)
                {
                    el.BeginAnimation(UIElement.OpacityProperty, null);
                    t.BeginAnimation(TranslateTransform.YProperty, null);
                    el.Opacity = 1;
                    t.Y = 0;
                    return;
                }
                DoubleAnimation fade = new DoubleAnimation(0, 1, D(180));
                DoubleAnimation move = new DoubleAnimation(dy, 0, D(220));
                move.EasingFunction = Out;
                el.BeginAnimation(UIElement.OpacityProperty, fade);
                t.BeginAnimation(TranslateTransform.YProperty, move);
            }
            else
            {
                if (el.Visibility != Visibility.Visible) return;
                if (!On)
                {
                    el.Visibility = Visibility.Collapsed;
                    return;
                }
                DoubleAnimation fade = new DoubleAnimation(0, D(150));
                DoubleAnimation move = new DoubleAnimation(dy, D(170));
                move.EasingFunction = Out;
                fade.Completed += delegate
                {
                    // Only finish hiding if nothing asked for it back in the meantime.
                    if (el.Opacity < 0.05) el.Visibility = Visibility.Collapsed;
                };
                el.BeginAnimation(UIElement.OpacityProperty, fade);
                t.BeginAnimation(TranslateTransform.YProperty, move);
            }
        }

        public static void To(Animatable target, DependencyProperty prop, double to, int ms)
        {
            if (!On)
            {
                target.BeginAnimation(prop, null);
                target.SetValue(prop, to);
                return;
            }
            DoubleAnimation a = new DoubleAnimation(to, D(ms));
            a.EasingFunction = Out;
            target.BeginAnimation(prop, a);
        }

        public static void To(UIElement target, DependencyProperty prop, double to, int ms)
        {
            if (!On)
            {
                target.BeginAnimation(prop, null);
                target.SetValue(prop, to);
                return;
            }
            DoubleAnimation a = new DoubleAnimation(to, D(ms));
            a.EasingFunction = Out;
            target.BeginAnimation(prop, a);
        }

        /** A dialog card growing slightly into place. */
        public static void Pop(FrameworkElement card)
        {
            ScaleTransform s = card.RenderTransform as ScaleTransform;
            if (s == null || s.IsFrozen)
            {
                s = new ScaleTransform();
                card.RenderTransform = s;
            }
            if (!On)
            {
                s.BeginAnimation(ScaleTransform.ScaleXProperty, null);
                s.BeginAnimation(ScaleTransform.ScaleYProperty, null);
                card.BeginAnimation(UIElement.OpacityProperty, null);
                s.ScaleX = s.ScaleY = 1;
                card.Opacity = 1;
                return;
            }
            DoubleAnimation grow = new DoubleAnimation(0.96, 1, D(200));
            grow.EasingFunction = Out;
            s.BeginAnimation(ScaleTransform.ScaleXProperty, grow);
            s.BeginAnimation(ScaleTransform.ScaleYProperty, grow);
            card.BeginAnimation(UIElement.OpacityProperty, new DoubleAnimation(0, 1, D(160)));
        }

        /**
         * A busy indicator: a short arc with rounded ends turning over a faint full ring. It keeps
         * turning even with animations off, more slowly, because a still spinner reads as a hang.
         */
        public static FrameworkElement Spinner(double size, Brush brush)
        {
            Grid g = new Grid();
            g.Width = size;
            g.Height = size;
            double stroke = Math.Max(1.6, size / 9);
            double r = (size - stroke) / 2;
            double c = size / 2;

            Ellipse track = new Ellipse();
            track.Stroke = brush;
            track.StrokeThickness = stroke;
            track.Opacity = 0.22;
            track.Margin = new Thickness(stroke / 2);
            g.Children.Add(track);

            double sweep = 100 * Math.PI / 180;
            PathFigure fig = new PathFigure();
            fig.StartPoint = new Point(c, c - r);
            fig.Segments.Add(new ArcSegment(new Point(c + r * Math.Sin(sweep), c - r * Math.Cos(sweep)), new Size(r, r), 0, false, SweepDirection.Clockwise, true));
            PathGeometry geo = new PathGeometry();
            geo.Figures.Add(fig);
            Path arc = new Path();
            arc.Data = geo;
            arc.Stroke = brush;
            arc.StrokeThickness = stroke;
            arc.StrokeStartLineCap = PenLineCap.Round;
            arc.StrokeEndLineCap = PenLineCap.Round;
            RotateTransform spin = new RotateTransform(0, c, c);
            arc.RenderTransform = spin;
            g.Children.Add(arc);

            DoubleAnimation turn = new DoubleAnimation(0, 360, new Duration(TimeSpan.FromMilliseconds(On ? 900 : 1800)));
            turn.RepeatBehavior = RepeatBehavior.Forever;
            spin.BeginAnimation(RotateTransform.AngleProperty, turn);
            g.IsHitTestVisible = false;
            return g;
        }

        /** A soft ring that keeps pulsing outward from a status dot while the server is running. */
        public static void Pulse(Ellipse halo, bool run)
        {
            ScaleTransform s = halo.RenderTransform as ScaleTransform;
            if (s == null || s.IsFrozen)
            {
                s = new ScaleTransform();
                halo.RenderTransform = s;
            }
            if (!run || !On)
            {
                halo.BeginAnimation(UIElement.OpacityProperty, null);
                s.BeginAnimation(ScaleTransform.ScaleXProperty, null);
                s.BeginAnimation(ScaleTransform.ScaleYProperty, null);
                halo.Opacity = 0;
                return;
            }
            Duration d = new Duration(TimeSpan.FromMilliseconds(1800));
            DoubleAnimation grow = new DoubleAnimation(0.8, 2.4, d);
            grow.RepeatBehavior = RepeatBehavior.Forever;
            grow.EasingFunction = Out;
            DoubleAnimation fade = new DoubleAnimation(0.55, 0, d);
            fade.RepeatBehavior = RepeatBehavior.Forever;
            s.BeginAnimation(ScaleTransform.ScaleXProperty, grow);
            s.BeginAnimation(ScaleTransform.ScaleYProperty, grow);
            halo.BeginAnimation(UIElement.OpacityProperty, fade);
        }
    }

    // -----------------------------------------------------------------------------------------
    // Contrast: the check that would have caught black text on the dark theme.
    // -----------------------------------------------------------------------------------------

    public static class Contrast
    {
        static double Channel(byte v)
        {
            double c = v / 255.0;
            return c <= 0.03928 ? c / 12.92 : Math.Pow((c + 0.055) / 1.055, 2.4);
        }

        public static double Luminance(Color c)
        {
            return 0.2126 * Channel(c.R) + 0.7152 * Channel(c.G) + 0.0722 * Channel(c.B);
        }

        public static double Ratio(Color a, Color b)
        {
            double x = Luminance(a), y = Luminance(b);
            return (Math.Max(x, y) + 0.05) / (Math.Min(x, y) + 0.05);
        }

        static bool Opaque(Brush b, out Color c)
        {
            c = Colors.Transparent;
            SolidColorBrush s = b as SolidColorBrush;
            if (s == null || s.Color.A < 0xf0 || s.Opacity < 0.99) return false;
            c = s.Color;
            return true;
        }

        static Brush BackgroundOf(DependencyObject d)
        {
            Border b = d as Border;
            if (b != null) return b.Background;
            Panel p = d as Panel;
            if (p != null) return p.Background;
            // Not Control.Background: a control only paints it if its template asks, and the
            // system styles give controls a white one that these templates never draw.
            return null;
        }

        /**
         * What a piece of text is drawn on: the nearest ancestor with a solid background, or a
         * solid, fully visible sibling layered beneath it, which is how the templates paint fills.
         */
        public static Color BackgroundBehind(DependencyObject el, Color fallback)
        {
            DependencyObject child = el;
            DependencyObject parent = VisualTreeHelper.GetParent(el);
            while (parent != null)
            {
                Panel panel = parent as Panel;
                if (panel != null)
                {
                    int idx = panel.Children.IndexOf(child as UIElement);
                    Point centre = new Point(-1, -1);
                    try
                    {
                        UIElement self = el as UIElement;
                        if (self != null) centre = self.TransformToAncestor(panel).Transform(new Point(self.RenderSize.Width / 2, self.RenderSize.Height / 2));
                    }
                    catch { }
                    for (int i = idx - 1; i >= 0; i--)
                    {
                        UIElement sib = panel.Children[i];
                        if (!sib.IsVisible || sib.Opacity < 0.99) continue;
                        // Only a layer actually under the text counts, not one beside it.
                        try
                        {
                            Rect r = sib.TransformToAncestor(panel).TransformBounds(new Rect(sib.RenderSize));
                            if (!r.Contains(centre)) continue;
                        }
                        catch { continue; }
                        Color sc;
                        if (Opaque(BackgroundOf(sib), out sc)) return sc;
                    }
                }
                Color c;
                if (Opaque(BackgroundOf(parent), out c)) return c;
                child = parent;
                parent = VisualTreeHelper.GetParent(parent);
            }
            return fallback;
        }

        /** Every visible piece of text under `root` whose contrast is below `min`. */
        public static List<string> Failures(DependencyObject root, Color page, double min)
        {
            List<string> bad = new List<string>();
            Walk(root, page, min, bad);
            return bad;
        }

        static void Walk(DependencyObject d, Color page, double min, List<string> bad)
        {
            UIElement u = d as UIElement;
            if (u != null && !u.IsVisible) return;
            TextBlock tb = d as TextBlock;
            if (tb != null && !string.IsNullOrEmpty(tb.Text) && tb.Opacity > 0.05)
            {
                SolidColorBrush fg = tb.Foreground as SolidColorBrush;
                if (fg != null)
                {
                    Color bg = BackgroundBehind(tb, page);
                    double r = Ratio(fg.Color, bg);
                    if (r < min) bad.Add("\"" + Trim(tb.Text) + "\" " + fg.Color + " on " + bg + " = " + r.ToString("0.00"));
                }
            }
            Control c = d as Control;
            if ((d is TextBox || d is PasswordBox) && c != null)
            {
                SolidColorBrush fg = c.Foreground as SolidColorBrush, bg = c.Background as SolidColorBrush;
                if (fg != null && bg != null)
                {
                    double r = Ratio(fg.Color, bg.Color);
                    if (r < min) bad.Add(c.GetType().Name + " text " + fg.Color + " on " + bg.Color + " = " + r.ToString("0.00"));
                }
            }
            int n = VisualTreeHelper.GetChildrenCount(d);
            for (int i = 0; i < n; i++) Walk(VisualTreeHelper.GetChild(d, i), page, min, bad);
        }

        static string Trim(string s)
        {
            s = s.Replace('\n', ' ');
            return s.Length > 40 ? s.Substring(0, 40) + "..." : s;
        }
    }
}
