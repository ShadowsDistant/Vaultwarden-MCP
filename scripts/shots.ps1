# Captures the README screenshots from the card's demo modes, using headless Edge.
#
#   node scripts/serve-ui.mjs      # in another terminal
#   .\scripts\shots.ps1
#
# Each shot is cropped to the card, so the images stay tight whatever the window size.

param(
  [int]$Port = 8766,
  [string]$OutDir
)

$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
if (-not $OutDir) { $OutDir = Join-Path $repo 'docs\shots' }
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null

# ${env:ProgramFiles(x86)} needs the braces: the parentheses would otherwise end the variable
# name and the path would silently come out wrong.
$edge = @(
  "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe",
  "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe"
) | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $edge) { throw 'Microsoft Edge was not found.' }

# view, theme, height
$shots = @(
  @('status', 'light', 300),
  @('status', 'dark', 300),
  @('item', 'light', 560),
  @('item', 'dark', 560),
  @('list', 'light', 460),
  @('draft', 'light', 720),
  @('confirm', 'light', 400),
  @('delete', 'light', 420),
  @('generator', 'light', 340),
  @('locked', 'dark', 300)
)

Add-Type -AssemblyName System.Drawing

foreach ($s in $shots) {
  $view = $s[0]; $theme = $s[1]; $height = $s[2]
  $name = "$view-$theme.png"
  $raw = Join-Path $env:TEMP "vw-shot-raw.png"
  $url = "http://localhost:$Port/card.html?demo=$view&theme=$theme&shot=1"
  # Edge reports "N bytes written to file" on stderr even on success. Under
  # $ErrorActionPreference = 'Stop' that becomes a terminating NativeCommandError, so this one
  # call runs with the preference relaxed. Do not redirect the stream: in Windows PowerShell
  # 5.1 that wraps each line in an ErrorRecord and makes the problem worse.
  $prev = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    & $edge --headless=new --disable-gpu --hide-scrollbars --force-device-scale-factor=2 `
      --window-size=500,$height "--screenshot=$raw" $url | Out-Null
  } finally {
    $ErrorActionPreference = $prev
  }
  if (-not (Test-Path $raw)) { Write-Warning "no shot for $name"; continue }

  # Trim the flat surface colour from the right and bottom so each image hugs its card.
  $img = [System.Drawing.Bitmap]::FromFile($raw)
  $bg = $img.GetPixel(2, 2)
  $maxX = 0; $maxY = 0
  for ($y = 0; $y -lt $img.Height; $y += 2) {
    for ($x = 0; $x -lt $img.Width; $x += 2) {
      $p = $img.GetPixel($x, $y)
      if ([Math]::Abs($p.R - $bg.R) + [Math]::Abs($p.G - $bg.G) + [Math]::Abs($p.B - $bg.B) -gt 12) {
        if ($x -gt $maxX) { $maxX = $x }
        if ($y -gt $maxY) { $maxY = $y }
      }
    }
  }
  $pad = 40
  $w = [Math]::Min($img.Width, $maxX + $pad)
  $h = [Math]::Min($img.Height, $maxY + $pad)
  $crop = New-Object System.Drawing.Bitmap($w, $h)
  $g = [System.Drawing.Graphics]::FromImage($crop)
  $g.DrawImage($img, (New-Object System.Drawing.Rectangle(0, 0, $w, $h)), (New-Object System.Drawing.Rectangle(0, 0, $w, $h)), [System.Drawing.GraphicsUnit]::Pixel)
  $g.Dispose()
  $crop.Save((Join-Path $OutDir $name), [System.Drawing.Imaging.ImageFormat]::Png)
  $crop.Dispose(); $img.Dispose()
  Remove-Item -Force $raw
  Write-Host "wrote $name (${w}x${h})"
}
