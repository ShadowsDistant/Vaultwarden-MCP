# Clipboard helper for Vaultwarden MCP (Windows).
#
#   -Set        : reads the secret from stdin and puts it on the clipboard
#   -Clear <h>  : clears the clipboard, but only if it still holds the value whose
#                 SHA-256 is <h> (so a later copy by the user is never wiped)
#
# The secret arrives on stdin, never as an argument: command lines are visible to every
# process on the machine and are recorded by command-line auditing and EDR agents.
#
# Windows keeps a clipboard history (Win+V) and can sync the clipboard to other devices.
# A password left in either outlives the 30-second window this server promises, so the
# copy is tagged with the three formats that opt out of both. This is what the Bitwarden
# and KeePass desktop clients do.

param(
  [switch]$Set,
  [string]$Clear
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms

function Set-Excluded([string]$text) {
  $data = New-Object System.Windows.Forms.DataObject
  $data.SetText($text)
  # Presence alone is the signal for the first; the other two are DWORD 0.
  $data.SetData('ExcludeClipboardContentFromMonitorProcessing', (New-Object System.IO.MemoryStream(1)))
  $zero = New-Object System.IO.MemoryStream 4
  $zero.Write([byte[]]@(0, 0, 0, 0), 0, 4)
  $data.SetData('CanIncludeInClipboardHistory', $zero)
  $zero2 = New-Object System.IO.MemoryStream 4
  $zero2.Write([byte[]]@(0, 0, 0, 0), 0, 4)
  $data.SetData('CanUploadToCloudClipboard', $zero2)
  [System.Windows.Forms.Clipboard]::SetDataObject($data, $true, 8, 60)
}

function Get-Sha([string]$text) {
  $sha = [System.Security.Cryptography.SHA256]::Create()
  $bytes = $sha.ComputeHash([System.Text.Encoding]::UTF8.GetBytes($text))
  $sha.Dispose()
  return ([System.BitConverter]::ToString($bytes) -replace '-', '').ToLowerInvariant()
}

try {
  if ($Set) {
    $secret = [Console]::In.ReadToEnd()
    # Only a trailing newline added by the pipe is stripped: a password may legitimately
    # end in a space.
    $secret = $secret -replace "`r?`n$", ''
    if ([string]::IsNullOrEmpty($secret)) { exit 1 }
    Set-Excluded $secret
    [Console]::Out.Write((Get-Sha $secret))
    exit 0
  }

  if ($Clear) {
    $current = ''
    try { $current = [System.Windows.Forms.Clipboard]::GetText() } catch { $current = '' }
    if ($current -and (Get-Sha $current) -eq $Clear.ToLowerInvariant()) {
      [System.Windows.Forms.Clipboard]::Clear()
      [Console]::Out.Write('cleared')
    } else {
      [Console]::Out.Write('kept')
    }
    exit 0
  }

  exit 2
} catch {
  [Console]::Error.Write($_.Exception.Message)
  exit 1
}
