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
  [int]$IdleLockMinutes = 15,
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

Push-Location $build
try {
  Write-Host 'installing dependencies...'
  # Sanitize PATH for the child: the machine PATH here has an unbalanced quote that kills any
  # batch file npm shells out to, with the useless message "operable program or batch file".
  $clean = ($env:PATH -split ';' | ForEach-Object { $_ -replace '"', '' } | Where-Object { $_.Trim() -ne '' }) -join ';'
  $old = $env:PATH
  $env:PATH = $clean
  try {
    $lock = Join-Path $build 'package-lock.json'
    if (Test-Path $lock) {
      # --legacy-peer-deps: the MCP Apps SDK declares react as a peer, and this server renders none.
      & $node $npmCli ci --legacy-peer-deps --no-audit --no-fund
      if ($LASTEXITCODE -ne 0) {
        Write-Host 'npm ci failed on the copied lockfile; falling back to npm install.'
        Remove-Item -Force $lock
        & $node $npmCli install --legacy-peer-deps --no-audit --no-fund
      }
    } else {
      & $node $npmCli install --legacy-peer-deps --no-audit --no-fund
    }
    if ($LASTEXITCODE -ne 0) { throw "Dependency install failed with exit code $LASTEXITCODE." }
  } finally {
    $env:PATH = $old
  }

  Write-Host 'compiling...'
  & $node (Join-Path $build 'node_modules\typescript\bin\tsc') -p tsconfig.json
  if ($LASTEXITCODE -ne 0) { throw "TypeScript compilation failed." }

  Write-Host 'bundling the card...'
  & $node (Join-Path $build 'scripts\build-ui.mjs')
  if ($LASTEXITCODE -ne 0) { throw "The card bundle failed." }
} finally {
  Pop-Location
}

Write-Host ''
Write-Host "Built: $(Join-Path $build 'dist\index.js')"

if ($Install) {
  if (-not $Server) { throw "Pass -Server https://your-vault.example.com so the server knows which instance to use." }
  $args = @((Join-Path $build 'scripts\install.mjs'), '--server', $Server, '--idle-lock', "$IdleLockMinutes")
  if ($Email) { $args += @('--email', $Email) }
  if ($NoReveal) { $args += '--no-reveal' }
  if ($AllowHttp) { $args += '--allow-http' }
  $env:VW_MCP_HOME = $home_
  & $node @args
  if ($LASTEXITCODE -ne 0) { throw "Registering with Claude Desktop failed." }
} else {
  Write-Host ''
  Write-Host 'To register it with Claude Desktop:'
  Write-Host "  .\scripts\setup.ps1 -Install -Server https://your-vault.example.com"
}
