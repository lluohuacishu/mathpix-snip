param([ValidateSet('protect','unprotect')][string]$Mode)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Security
$inputValue = [Console]::In.ReadToEnd()
if ($Mode -eq 'protect') {
  $bytes = [Text.Encoding]::UTF8.GetBytes($inputValue)
  $encrypted = [Security.Cryptography.ProtectedData]::Protect($bytes, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser)
  [Console]::Out.Write([Convert]::ToBase64String($encrypted))
} else {
  $bytes = [Convert]::FromBase64String($inputValue)
  $decrypted = [Security.Cryptography.ProtectedData]::Unprotect($bytes, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser)
  [Console]::Out.Write([Text.Encoding]::UTF8.GetString($decrypted))
}
