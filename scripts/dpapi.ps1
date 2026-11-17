<#
  Protects or unprotects one short value with Windows DPAPI, for the current Windows user only.

  The value arrives on stdin and leaves on stdout, never on the command line. Used to share one
  unlocked session between the server processes an AI app starts, and to keep it across restarts
  when the user chose "never lock".

    powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File dpapi.ps1 -Mode protect|unprotect
#>
param([Parameter(Mandatory = $true)][ValidateSet('protect', 'unprotect')][string]$Mode)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Security

$utf8 = New-Object System.Text.UTF8Encoding($false)
$stdin = New-Object System.IO.StreamReader([Console]::OpenStandardInput(), $utf8)
$text = $stdin.ReadToEnd().Trim()
$entropy = $utf8.GetBytes('bitwarden-mcp/session/v1')
$scope = [System.Security.Cryptography.DataProtectionScope]::CurrentUser

if ($Mode -eq 'protect') {
  $out = [System.Security.Cryptography.ProtectedData]::Protect($utf8.GetBytes($text), $entropy, $scope)
  $result = [Convert]::ToBase64String($out)
} else {
  $out = [System.Security.Cryptography.ProtectedData]::Unprotect([Convert]::FromBase64String($text), $entropy, $scope)
  $result = $utf8.GetString($out)
}
$stdout = New-Object System.IO.StreamWriter([Console]::OpenStandardOutput(), $utf8)
$stdout.Write($result)
$stdout.Flush()
