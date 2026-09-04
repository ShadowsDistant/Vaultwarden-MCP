# Draws the project mark: a rounded shield with a keyhole, on a deep slate ground.
# Writes assets/icon.png (512), the smaller sizes used by serverInfo.icons, and assets/icon.ico
# for the native dialog's window chrome.
#
# Everything is drawn at $master and downsampled, so the layout maths only has to work once.

param([int]$master = 512)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$root = Split-Path -Parent $PSScriptRoot
$assets = Join-Path $root 'assets'
New-Item -ItemType Directory -Force -Path $assets | Out-Null

function New-Icon([int]$size) {
  $bmp = New-Object System.Drawing.Bitmap($size, $size)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = 'AntiAlias'
  $g.InterpolationMode = 'HighQualityBicubic'
  $g.PixelOffsetMode = 'HighQuality'

  $s = [double]$size
  $r = $s * 0.22

  # Ground: a rounded square with a vertical slate gradient.
  $gp = New-Object System.Drawing.Drawing2D.GraphicsPath
  $d = $r * 2
  $gp.AddArc(0, 0, $d, $d, 180, 90)
  $gp.AddArc($s - $d, 0, $d, $d, 270, 90)
  $gp.AddArc($s - $d, $s - $d, $d, $d, 0, 90)
  $gp.AddArc(0, $s - $d, $d, $d, 90, 90)
  $gp.CloseFigure()
  $grad = New-Object System.Drawing.Drawing2D.LinearGradientBrush(
    (New-Object System.Drawing.Point(0, 0)),
    (New-Object System.Drawing.Point(0, [int]$s)),
    [System.Drawing.Color]::FromArgb(255, 42, 52, 66),
    [System.Drawing.Color]::FromArgb(255, 24, 30, 40))
  $g.FillPath($grad, $gp)

  # Shield.
  $cx = $s / 2
  $top = $s * 0.20
  $w = $s * 0.30
  $shoulder = $s * 0.50
  $tip = $s * 0.82
  $sp = New-Object System.Drawing.Drawing2D.GraphicsPath
  $sp.AddLine([single]($cx - $w), [single]$top, [single]($cx + $w), [single]$top)
  $sp.AddBezier([single]($cx + $w), [single]$top, [single]($cx + $w), [single]$shoulder,
                [single]($cx + $w * 0.86), [single]($tip - $s * 0.14), [single]$cx, [single]$tip)
  $sp.AddBezier([single]$cx, [single]$tip, [single]($cx - $w * 0.86), [single]($tip - $s * 0.14),
                [single]($cx - $w), [single]$shoulder, [single]($cx - $w), [single]$top)
  $sp.CloseFigure()
  $shieldGrad = New-Object System.Drawing.Drawing2D.LinearGradientBrush(
    (New-Object System.Drawing.Point(0, [int]$top)),
    (New-Object System.Drawing.Point(0, [int]$tip)),
    [System.Drawing.Color]::FromArgb(255, 96, 165, 250),
    [System.Drawing.Color]::FromArgb(255, 45, 110, 220))
  $g.FillPath($shieldGrad, $sp)

  # Keyhole: a circle over a tapered stem, punched out in the ground colour.
  $hole = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(255, 24, 30, 40))
  $kr = $s * 0.075
  $ky = $s * 0.415
  $g.FillEllipse($hole, [single]($cx - $kr), [single]($ky - $kr), [single]($kr * 2), [single]($kr * 2))
  $stem = New-Object System.Drawing.Drawing2D.GraphicsPath
  $sw = $kr * 0.62
  $sb = $s * 0.615
  $stem.AddLine([single]($cx - $sw), [single]$ky, [single]($cx + $sw), [single]$ky)
  $stem.AddLine([single]($cx + $sw), [single]$ky, [single]($cx + $sw * 1.5), [single]$sb)
  $stem.AddLine([single]($cx + $sw * 1.5), [single]$sb, [single]($cx - $sw * 1.5), [single]$sb)
  $stem.CloseFigure()
  $g.FillPath($hole, $stem)

  $g.Dispose()
  return $bmp
}

$big = New-Icon $master
foreach ($sz in 512, 256, 96, 48, 32, 16) {
  $out = New-Object System.Drawing.Bitmap($sz, $sz)
  $g = [System.Drawing.Graphics]::FromImage($out)
  $g.InterpolationMode = 'HighQualityBicubic'
  $g.SmoothingMode = 'AntiAlias'
  $g.PixelOffsetMode = 'HighQuality'
  $g.DrawImage($big, (New-Object System.Drawing.Rectangle(0, 0, $sz, $sz)))
  $g.Dispose()
  $name = if ($sz -eq 512) { 'icon.png' } else { "icon-$sz.png" }
  $out.Save((Join-Path $assets $name), [System.Drawing.Imaging.ImageFormat]::Png)
  $out.Dispose()
  Write-Host "wrote $name"
}

# An .ico for the dialog's window chrome. Written by hand: Bitmap.Save with the Icon format
# produces a 1-bit-per-pixel mess, and Icon.FromHandle loses the alpha channel.
$sizes = 16, 32, 48, 256
$streams = @()
foreach ($sz in $sizes) {
  $out = New-Object System.Drawing.Bitmap($sz, $sz)
  $g = [System.Drawing.Graphics]::FromImage($out)
  $g.InterpolationMode = 'HighQualityBicubic'
  $g.SmoothingMode = 'AntiAlias'
  $g.PixelOffsetMode = 'HighQuality'
  $g.DrawImage($big, (New-Object System.Drawing.Rectangle(0, 0, $sz, $sz)))
  $g.Dispose()
  $ms = New-Object System.IO.MemoryStream
  $out.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
  $out.Dispose()
  $streams += , @{ size = $sz; bytes = $ms.ToArray() }
  $ms.Dispose()
}
$icoPath = Join-Path $assets 'icon.ico'
$fs = [System.IO.File]::Create($icoPath)
$bw = New-Object System.IO.BinaryWriter($fs)
$bw.Write([uint16]0); $bw.Write([uint16]1); $bw.Write([uint16]$streams.Count)
$offset = 6 + 16 * $streams.Count
foreach ($e in $streams) {
  $dim = if ($e.size -ge 256) { 0 } else { $e.size }
  $bw.Write([byte]$dim); $bw.Write([byte]$dim)
  $bw.Write([byte]0); $bw.Write([byte]0)
  $bw.Write([uint16]1); $bw.Write([uint16]32)
  $bw.Write([uint32]$e.bytes.Length); $bw.Write([uint32]$offset)
  $offset += $e.bytes.Length
}
foreach ($e in $streams) { $bw.Write($e.bytes) }
$bw.Flush(); $bw.Dispose(); $fs.Dispose()
Write-Host "wrote icon.ico"

# The SVG twin, for serverInfo.icons and the README. The coordinates below are the same
# numbers the drawing code above computes at 512 px, so the two marks stay identical.
$svg = @'
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512" role="img" aria-label="Vaultwarden MCP">
  <defs>
    <linearGradient id="ground" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#2A3442"/><stop offset="1" stop-color="#181E28"/>
    </linearGradient>
    <linearGradient id="shield" x1="0" y1="0.2" x2="0" y2="0.82">
      <stop offset="0" stop-color="#60A5FA"/><stop offset="1" stop-color="#2D6EDC"/>
    </linearGradient>
  </defs>
  <rect width="512" height="512" rx="112.6" fill="url(#ground)"/>
  <path fill="url(#shield)"
        d="M102.4 102.4 L409.6 102.4 C409.6 256 388.1 348.2 256 419.8 C123.9 348.2 102.4 256 102.4 102.4 Z"/>
  <circle cx="256" cy="212.5" r="38.4" fill="#181E28"/>
  <path fill="#181E28" d="M232.2 212.5 H279.8 L291.7 314.9 H220.3 Z"/>
</svg>
'@
Set-Content -Path (Join-Path $assets 'icon.svg') -Value $svg -Encoding utf8
Write-Host "wrote icon.svg"
$big.Dispose()
