<#
  Builds Vaultwarden-MCP-Settings.exe, the Windows settings app.

  No SDK or NuGet is needed. It compiles with the Roslyn csc that ships with Visual Studio or
  the Build Tools when one is installed, and otherwise with the C# compiler that is part of
  every .NET Framework 4.x install. The source is written to compile under either.

    powershell -ExecutionPolicy Bypass -File scripts\build-settings.ps1 [-Out dist\settings] [-SelfTest]
#>
param(
  [string]$Out = '',
  [switch]$SelfTest,
  # Force the .NET Framework compiler even when Roslyn is installed, to prove the fallback works.
  [switch]$Legacy
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
if (-not $Out) { $Out = Join-Path $root 'dist\settings' }
$src = Join-Path $root 'settings-app'

function Find-Csc {
  if ($Legacy) {
    $p = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
    if (Test-Path $p) { return $p }
  }
  $vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer\vswhere.exe'
  if (Test-Path $vswhere) {
    $found = & $vswhere -latest -products '*' -find 'MSBuild\**\Roslyn\csc.exe' 2>$null | Select-Object -First 1
    if ($found -and (Test-Path $found)) { return $found }
  }
  foreach ($fw in @('Framework64', 'Framework')) {
    $p = Join-Path $env:WINDIR "Microsoft.NET\$fw\v4.0.30319\csc.exe"
    if (Test-Path $p) { return $p }
  }
  throw 'No C# compiler found. Install the .NET Framework 4.8 (built into Windows 10 and 11) or Visual Studio Build Tools.'
}

# Reference assemblies: the targeting pack when present, else the runtime's own copies.
function Find-RefDir {
  $pf = ${env:ProgramFiles(x86)}
  foreach ($v in @('v4.8.1', 'v4.8', 'v4.7.2', 'v4.7.1', 'v4.7', 'v4.6.2')) {
    $d = Join-Path $pf "Reference Assemblies\Microsoft\Framework\.NETFramework\$v"
    if (Test-Path (Join-Path $d 'PresentationFramework.dll')) { return $d }
  }
  return $null
}

$csc = Find-Csc
$refDir = Find-RefDir
$runtime = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319'
if (-not (Test-Path $runtime)) { $runtime = Join-Path $env:WINDIR 'Microsoft.NET\Framework\v4.0.30319' }

$refs = @('System.dll', 'System.Core.dll', 'System.Xml.dll', 'System.Xaml.dll', 'System.Web.Extensions.dll',
          'WindowsBase.dll', 'PresentationCore.dll', 'PresentationFramework.dll')
$refArgs = foreach ($r in $refs) {
  if ($refDir) { "/reference:$(Join-Path $refDir $r)" }
  elseif ($r -in @('WindowsBase.dll', 'PresentationCore.dll', 'PresentationFramework.dll')) { "/reference:$(Join-Path $runtime "WPF\$r")" }
  else { "/reference:$(Join-Path $runtime $r)" }
}

New-Item -ItemType Directory -Force -Path $Out | Out-Null
$exe = Join-Path $Out 'Vaultwarden-MCP-Settings.exe'

$cscArgs = @(
  '/nologo', '/target:winexe', '/optimize+', '/platform:anycpu', '/utf8output', '/codepage:65001',
  "/out:$exe",
  "/win32icon:$(Join-Path $root 'assets\icon.ico')",
  "/win32manifest:$(Join-Path $src 'app.manifest')",
  "/resource:$(Join-Path $src 'MainWindow.xaml'),MainWindow.xaml",
  "/resource:$(Join-Path $root 'assets\icon-96.png'),icon.png"
)
if ($refDir) { $cscArgs += '/nostdlib+'; $cscArgs += "/reference:$(Join-Path $refDir 'mscorlib.dll')" }
$cscArgs += $refArgs
$cscArgs += (Join-Path $src 'Program.cs')

Write-Host "csc: $csc"
& $csc @cscArgs
if ($LASTEXITCODE -ne 0) { throw "csc failed with exit code $LASTEXITCODE" }
Write-Host "built $exe"

if ($SelfTest) {
  $log = Join-Path ([IO.Path]::GetTempPath()) "vw-settings-selftest-$PID.txt"
  $p = Start-Process -FilePath $exe -ArgumentList '--selftest' -Wait -PassThru -NoNewWindow -RedirectStandardOutput $log
  Get-Content $log | ForEach-Object { Write-Host $_ }
  Remove-Item $log -ErrorAction SilentlyContinue
  if ($p.ExitCode -ne 0) { throw "self-test failed ($($p.ExitCode))" }
}
