# Native dialog for Vaultwarden MCP (Windows).
#
# Reads a JSON spec on stdin, shows a WPF window, writes {"ok":true,"values":{...}} or
# {"ok":false} on stdout. The value the user types goes down that pipe and nowhere else.
#
# The window is built control by control rather than from a XAML string. Every label in a
# spec can contain vault content, and vault content is attacker-influenced; interpolating it
# into markup would be an injection hole in the one dialog that must not have any.
#
# Requires -STA (WPF) and -ExecutionPolicy Bypass (client default is Restricted, under which
# -File fails silently).

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

function Write-Result($obj) {
  $json = $obj | ConvertTo-Json -Compress -Depth 6
  [Console]::Out.Write($json)
  [Console]::Out.Flush()
}

try {
  $raw = [Console]::In.ReadToEnd()
  if ([string]::IsNullOrWhiteSpace($raw)) { Write-Result @{ ok = $false }; exit 1 }
  # Skip anything before the opening brace. A writer with no control over its stream encoding
  # can prepend a byte-order mark, and ConvertFrom-Json rejects the whole document over it.
  $start = $raw.IndexOf('{')
  if ($start -lt 0) { Write-Result @{ ok = $false }; exit 1 }
  $spec = $raw.Substring($start) | ConvertFrom-Json

  Add-Type -AssemblyName PresentationFramework, PresentationCore, WindowsBase, System.Drawing

  # Follow the system theme so the dialog does not flash white on a dark desktop.
  $light = 1
  try {
    $light = (Get-ItemProperty -Path 'HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\Themes\Personalize' -Name AppsUseLightTheme -ErrorAction Stop).AppsUseLightTheme
  } catch { $light = 1 }

  if ($light -eq 0) {
    $cBg = '#FF202020'; $cCard = '#FF2B2B2B'; $cFg = '#FFF3F3F3'; $cMuted = '#FFA0A0A0'
    $cLine = '#FF3D3D3D'; $cField = '#FF1B1B1B'; $cAccent = '#FF4C8DFF'; $cAccentFg = '#FFFFFFFF'
    $cDanger = '#FFE05A4F'; $cBtn = '#FF383838'
  } else {
    $cBg = '#FFF7F7F5'; $cCard = '#FFFFFFFF'; $cFg = '#FF1A1A19'; $cMuted = '#FF6B6B66'
    $cLine = '#FFE2E0DA'; $cField = '#FFFFFFFF'; $cAccent = '#FF2F6FE0'; $cAccentFg = '#FFFFFFFF'
    $cDanger = '#FFC0392B'; $cBtn = '#FFEFEDE7'
  }
  function B([string]$hex) { (New-Object System.Windows.Media.BrushConverter).ConvertFromString($hex) }

  $win = New-Object System.Windows.Window
  $win.Title = [string]$spec.title
  $win.SizeToContent = 'Height'
  $win.Width = 440
  $win.WindowStartupLocation = 'CenterScreen'
  $win.ResizeMode = 'NoResize'
  $win.Topmost = $true
  $win.Background = B $cBg
  $win.FontFamily = New-Object System.Windows.Media.FontFamily('Segoe UI')
  $win.ShowInTaskbar = $true
  # The shield mark, so the taskbar button and title bar are recognisably this server rather
  # than a stray PowerShell window asking for a password.
  $ico = Join-Path (Split-Path -Parent $PSScriptRoot) 'assets\icon.ico'
  if (-not (Test-Path $ico)) { $ico = Join-Path $PSScriptRoot '..\assets\icon.ico' }
  if (Test-Path $ico) {
    try { $win.Icon = New-Object System.Windows.Media.Imaging.BitmapImage((New-Object System.Uri((Resolve-Path $ico).Path))) } catch { }
  }

  $root = New-Object System.Windows.Controls.StackPanel
  $root.Margin = '22,20,22,18'
  $win.Content = $root

  # Header: a lock glyph plus the title, so the window reads as a credential prompt at a glance.
  $head = New-Object System.Windows.Controls.StackPanel
  $head.Orientation = 'Horizontal'
  $head.Margin = '0,0,0,10'
  # Segoe MDL2 Assets "Lock" (U+E72E). A BMP codepoint on purpose: the emoji padlock is
  # astral, and [char] cannot hold it.
  $glyph = New-Object System.Windows.Controls.TextBlock
  $glyph.Text = [string][char]0xE72E
  $glyph.FontFamily = New-Object System.Windows.Media.FontFamily('Segoe MDL2 Assets')
  $glyph.FontSize = 16
  $glyph.Foreground = B $cAccent
  $glyph.Margin = '0,1,9,0'
  $glyph.VerticalAlignment = 'Center'
  $head.Children.Add($glyph) | Out-Null
  $titleBlock = New-Object System.Windows.Controls.TextBlock
  $titleBlock.Text = [string]$spec.title
  $titleBlock.FontSize = 15
  $titleBlock.FontWeight = 'SemiBold'
  $titleBlock.Foreground = B $cFg
  $titleBlock.VerticalAlignment = 'Center'
  $head.Children.Add($titleBlock) | Out-Null
  $root.Children.Add($head) | Out-Null

  $msg = New-Object System.Windows.Controls.TextBlock
  $msg.Text = [string]$spec.message
  $msg.TextWrapping = 'Wrap'
  $msg.Foreground = B $cMuted
  $msg.FontSize = 12.5
  $msg.Margin = '0,0,0,14'
  $msg.LineHeight = 18
  $root.Children.Add($msg) | Out-Null

  $inputs = @{}
  $firstInput = $null

  if ($spec.fields) {
    foreach ($f in $spec.fields) {
      $lbl = New-Object System.Windows.Controls.TextBlock
      $lbl.Text = [string]$f.label
      $lbl.FontSize = 12
      $lbl.Foreground = B $cFg
      $lbl.Margin = '0,0,0,4'
      $root.Children.Add($lbl) | Out-Null

      $border = New-Object System.Windows.Controls.Border
      $border.BorderBrush = B $cLine
      $border.BorderThickness = 1
      $border.CornerRadius = 6
      $border.Background = B $cField
      $border.Margin = '0,0,0,12'
      $border.Padding = '9,7,9,7'

      if ($f.secret) {
        $box = New-Object System.Windows.Controls.PasswordBox
      } else {
        $box = New-Object System.Windows.Controls.TextBox
        if ($f.value) { $box.Text = [string]$f.value }
      }
      $box.BorderThickness = 0
      $box.Background = 'Transparent'
      $box.Foreground = B $cFg
      $box.CaretBrush = B $cFg
      $box.FontSize = 13
      if ($f.secret) { $box.FontFamily = New-Object System.Windows.Media.FontFamily('Consolas') }
      $border.Child = $box
      $root.Children.Add($border) | Out-Null
      $inputs[[string]$f.name] = $box
      if (-not $firstInput) { $firstInput = $box }
    }
  }

  $row = New-Object System.Windows.Controls.StackPanel
  $row.Orientation = 'Horizontal'
  $row.HorizontalAlignment = 'Right'
  $row.Margin = '0,6,0,0'

  # Rounded buttons need a ControlTemplate. This XAML is a constant with nothing
  # interpolated into it, so parsing it introduces no injection surface; the spec's strings
  # only ever reach .Content and .Text properties.
  $btnTemplateXaml = @'
<ControlTemplate xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation"
                 xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml"
                 TargetType="Button">
  <Border x:Name="bd" CornerRadius="6" Background="{TemplateBinding Background}" SnapsToDevicePixels="True">
    <ContentPresenter HorizontalAlignment="Center" VerticalAlignment="Center"/>
  </Border>
  <ControlTemplate.Triggers>
    <Trigger Property="IsMouseOver" Value="True">
      <Setter TargetName="bd" Property="Opacity" Value="0.88"/>
    </Trigger>
    <Trigger Property="IsPressed" Value="True">
      <Setter TargetName="bd" Property="Opacity" Value="0.74"/>
    </Trigger>
    <Trigger Property="IsKeyboardFocused" Value="True">
      <Setter TargetName="bd" Property="BorderThickness" Value="2"/>
      <Setter TargetName="bd" Property="BorderBrush" Value="#66000000"/>
    </Trigger>
  </ControlTemplate.Triggers>
</ControlTemplate>
'@
  $btnTemplate = [System.Windows.Markup.XamlReader]::Parse($btnTemplateXaml)

  function New-Btn([string]$text, [string]$bg, [string]$fg, [bool]$bold) {
    $b = New-Object System.Windows.Controls.Button
    $b.Content = $text
    $b.MinWidth = 92
    $b.Height = 32
    $b.Margin = '8,0,0,0'
    $b.Background = B $bg
    $b.Foreground = B $fg
    $b.BorderThickness = 0
    $b.FontSize = 12.5
    $b.Cursor = 'Hand'
    if ($bold) { $b.FontWeight = 'SemiBold' }
    $b.Template = $btnTemplate
    return $b
  }

  $isDanger = [bool]$spec.danger
  $okText = if ($spec.confirmLabel) { [string]$spec.confirmLabel } else { 'OK' }
  $cancelText = if ($spec.cancelLabel) { [string]$spec.cancelLabel } else { 'Cancel' }

  $okBg = if ($isDanger) { $cDanger } else { $cAccent }
  $btnCancel = New-Btn $cancelText $cBtn $cFg $false
  $btnOk = New-Btn $okText $okBg $cAccentFg $true

  $script:answer = $null
  $btnOk.Add_Click({
    $vals = @{}
    foreach ($k in $inputs.Keys) {
      $c = $inputs[$k]
      if ($c -is [System.Windows.Controls.PasswordBox]) { $vals[$k] = $c.Password } else { $vals[$k] = $c.Text }
    }
    $script:answer = @{ ok = $true; values = $vals }
    $win.Close()
  })
  $btnCancel.Add_Click({ $script:answer = @{ ok = $false }; $win.Close() })

  $row.Children.Add($btnCancel) | Out-Null
  $row.Children.Add($btnOk) | Out-Null
  $root.Children.Add($row) | Out-Null

  # Escape always cancels. Enter confirms, except on a destructive prompt where the safe
  # answer must be the one that takes no thought.
  $btnCancel.IsCancel = $true
  if (-not $isDanger) { $btnOk.IsDefault = $true } else { $btnCancel.IsDefault = $true }

  # Windows will not repaint the title bar to match a dark window on its own; without this
  # the chrome stays white above a dark body and the dialog looks broken.
  Add-Type -Namespace VwDwm -Name Api -MemberDefinition @'
[DllImport("dwmapi.dll")] public static extern int DwmSetWindowAttribute(IntPtr hwnd, int attr, ref int val, int size);
'@
  $win.Add_SourceInitialized({
    if ($light -eq 0) {
      try {
        $hwnd = (New-Object System.Windows.Interop.WindowInteropHelper($win)).Handle
        $on = 1
        # 20 is DWMWA_USE_IMMERSIVE_DARK_MODE; 19 was its number before Windows 10 20H1.
        if ([VwDwm.Api]::DwmSetWindowAttribute($hwnd, 20, [ref]$on, 4) -ne 0) {
          [void][VwDwm.Api]::DwmSetWindowAttribute($hwnd, 19, [ref]$on, 4)
        }
      } catch { }
    }
  })

  $win.Add_ContentRendered({
    $win.Activate() | Out-Null
    if ($firstInput) { $firstInput.Focus() | Out-Null } else { $btnCancel.Focus() | Out-Null }
  })

  $win.ShowDialog() | Out-Null

  if ($script:answer -and $script:answer.ok) { Write-Result $script:answer; exit 0 }
  Write-Result @{ ok = $false }
  exit 1
} catch {
  [Console]::Error.Write($_.Exception.Message)
  Write-Result @{ ok = $false }
  exit 1
}
