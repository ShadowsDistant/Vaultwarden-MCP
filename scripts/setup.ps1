# Builds Vaultwarden MCP into a runtime tree outside OneDrive, and optionally registers it
# with Claude Desktop.
#
#   .\scripts\setup.ps1
#   .\scripts\setup.ps1 -Install -Server https://vault.example.com -Email you@example.com
#
# Two reasons the build does not happen in place. OneDrive tries to sync node_modules, which
# is tens of thousands of files it has no business touching. And Claude Desktop is an MSIX
# package, so anything its children write under AppData\Local is silently redirected into the
# package's LocalCache — the user-profile root is the one place both sides agree on.
#
# node.exe and npm-cli.js are called directly rather than through the .cmd shims: a machine
# PATH containing an unbalanced quote breaks any batch file that expands %PATH%.

[CmdletBinding()]
param(
  [switch]$Install,
  [string]$Server,
  [string]$Email,
  [int]$IdleLockMinutes = -1,
  [switch]$NoReveal,
  [switch]$AllowHttp,
  [switch]$Clean
)

$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
$home_ = if ($env:VW_MCP_HOME) { $env:VW_MCP_HOME } else { Join-Path $env:USERPROFILE '.vaultwarden-mcp' }
$build = Join-Path $home_ 'build'

$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) { $node = 'C:\Program Files\nodejs\node.exe' }
if (-not (Test-Path $node)) { throw "Node was not found. Install Node 20 or newer from https://nodejs.org." }
$npmCli = Join-Path (Split-Path -Parent $node) 'node_modules\npm\bin\npm-cli.js'
if (-not (Test-Path $npmCli)) { throw "npm was not found next to $node." }

Write-Host "node:  $node"
Write-Host "build: $build"

if ($Clean -and (Test-Path $build)) {
  Write-Host 'cleaning the build tree...'
  Remove-Item -Recurse -Force $build
}
New-Item -ItemType Directory -Force -Path $build | Out-Null

# Copy sources across. node_modules and dist stay where they are so an incremental run is fast.
foreach ($entry in 'src', 'ui', 'scripts', 'assets', 'test') {
  $from = Join-Path $repo $entry
  if (-not (Test-Path $from)) { continue }
  $to = Join-Path $build $entry
  if (Test-Path $to) { Remove-Item -Recurse -Force $to }
  Copy-Item -Recurse -Force $from $to
}
foreach ($file in 'package.json', 'tsconfig.json', '.npmrc', 'package-lock.json', 'README.md', 'LICENSE', 'SECURITY.md') {
  $from = Join-Path $repo $file
  if (Test-Path $from) { Copy-Item -Force $from (Join-Path $build $file) }
}

# Runs a native command and judges it by its exit code alone.
#
# Under $ErrorActionPreference = 'Stop', anything a native executable writes to stderr becomes
# a terminating NativeCommandError — so npm's EBADENGINE warning, which is only a warning, would
# abort the build. Redirecting the stream is worse: Windows PowerShell 5.1 wraps each line in an
# ErrorRecord. Relaxing the preference for the call and checking $LASTEXITCODE is the honest way.
# Out-Host, not a bare call: a PowerShell function returns everything written to the output
# stream, so npm's own chatter would be returned alongside the exit code and every comparison
# against it would be against an array.
function Invoke-Native {
  param([string]$Exe, [string[]]$Arguments)
  $previous = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    # Both streams are turned back into plain text before they are printed. These tools log
    # their progress to stderr, and Windows PowerShell 5.1 wraps every stderr line in an
    # ErrorRecord — so without this, ordinary progress messages are rendered as scary red
    # NativeCommandError blocks with a stack trace attached.
    & $Exe @Arguments 2>&1 | ForEach-Object {
      if ($_ -is [System.Management.Automation.ErrorRecord]) { Write-Host $_.Exception.Message } else { Write-Host $_ }
    }
    return $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $previous
  }
}

Push-Location $build
try {
  Write-Host 'installing dependencies...'
  # Sanitize PATH for the child: the machine PATH here has an unbalanced quote that kills any
  # batch file npm shells out to, with the useless message "operable program or batch file".
  # Not $clean: PowerShell variable names are case-insensitive, so that would be the -Clean
  # switch parameter, and assigning a string to it throws a type error attributed to the call
  # site rather than to this line.
  $sanitizedPath = ($env:PATH -split ';' | ForEach-Object { $_ -replace '"', '' } | Where-Object { $_.Trim() -ne '' }) -join ';'
  $old = $env:PATH
  $env:PATH = $sanitizedPath
  try {
    $lock = Join-Path $build 'package-lock.json'
    $code = 0
    if (Test-Path $lock) {
      # --legacy-peer-deps: the MCP Apps SDK declares react as a peer, and this server renders none.
      $code = Invoke-Native $node @($npmCli, 'ci', '--legacy-peer-deps', '--no-audit', '--no-fund')
      if ($code -ne 0) {
        Write-Host 'npm ci failed on the copied lockfile; falling back to npm install.'
        Remove-Item -Force $lock
        $code = Invoke-Native $node @($npmCli, 'install', '--legacy-peer-deps', '--no-audit', '--no-fund')
      }
    } else {
      $code = Invoke-Native $node @($npmCli, 'install', '--legacy-peer-deps', '--no-audit', '--no-fund')
    }
    if ($code -ne 0) { throw "Dependency install failed with exit code $code." }
  } finally {
    $env:PATH = $old
  }

  Write-Host 'compiling...'
  $code = Invoke-Native $node @((Join-Path $build 'node_modules\typescript\bin\tsc'), '-p', 'tsconfig.json')
  if ($code -ne 0) { throw "TypeScript compilation failed." }

  Write-Host 'bundling the card...'
  $code = Invoke-Native $node @((Join-Path $build 'scripts\build-ui.mjs'))
  if ($code -ne 0) { throw "The card bundle failed." }
} finally {
  Pop-Location
}

Write-Host ''
Write-Host "Built: $(Join-Path $build 'dist\index.js')"

if ($Install) {
  if (-not $Server) { throw "Pass -Server https://your-vault.example.com so the server knows which instance to use." }
  # Not $args: that is an automatic variable in PowerShell, and assigning to it corrupts the
  # splat so the next call binds the wrong parameters entirely.
  $installArgs = @((Join-Path $build 'scripts\install.mjs'), '--server', $Server)
  # Only when asked for. Writing a value here pins it into the config file, where it would go
  # on overriding the server's own default long after that default has moved.
  if ($IdleLockMinutes -ge 0) { $installArgs += @('--idle-lock', "$IdleLockMinutes") }
  if ($Email) { $installArgs += @('--email', $Email) }
  if ($NoReveal) { $installArgs += '--no-reveal' }
  if ($AllowHttp) { $installArgs += '--allow-http' }
  $env:VW_MCP_HOME = $home_
  $code = Invoke-Native $node $installArgs
  if ($code -ne 0) { throw "Registering with Claude Desktop failed." }
} else {
  Write-Host ''
  Write-Host 'To register it with Claude Desktop:'
  Write-Host "  .\scripts\setup.ps1 -Install -Server https://your-vault.example.com"
}
