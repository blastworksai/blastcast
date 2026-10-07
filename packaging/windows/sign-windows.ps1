# ClaudeBWAI — einh 4 Oct: sign one file with signtool + the Azure Artifact Signing dlib, then verify it. Build-time only; never shipped.
# Usage: sign-windows.ps1 -Metadata <abs metadata.json> -EnvFile <abs azure-signing.env> [-SignTool <abs>] [-Dlib <abs>] <file>
# The env file holds AZURE_TENANT_ID, AZURE_CLIENT_ID and AZURE_CLIENT_SECRET. They are loaded into THIS process only and removed at the end.
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$Metadata,
  [Parameter(Mandatory = $true)][string]$EnvFile,
  [string]$SignTool,
  [string]$Dlib,
  [string]$TimestampUrl = 'http://timestamp.acs.microsoft.com',
  [Parameter(Mandatory = $true, Position = 0)][string]$File
)
$ErrorActionPreference = 'Stop'
$names = @('AZURE_TENANT_ID', 'AZURE_CLIENT_ID', 'AZURE_CLIENT_SECRET')
function Find-First([string[]]$patterns) {
  foreach ($pattern in $patterns) {
    if (-not $pattern) { continue }
    $hit = Get-ChildItem -Path $pattern -File -ErrorAction SilentlyContinue | Sort-Object FullName -Descending | Select-Object -First 1
    if ($hit) { return $hit.FullName }
  }
  return $null
}
try {
  foreach ($path in @($Metadata, $EnvFile, $File)) {
    if (-not [IO.Path]::IsPathRooted($path)) { throw "Path must be absolute: $path" }
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { throw "File not found: $path" }
  }
  if (-not $SignTool) {
    $onPath = Get-Command signtool.exe -ErrorAction SilentlyContinue
    if ($onPath) { $SignTool = $onPath.Source }
    else { $SignTool = Find-First @("${env:ProgramFiles(x86)}\Windows Kits\10\bin\*\x64\signtool.exe", "$env:ProgramFiles\Windows Kits\10\bin\*\x64\signtool.exe") }
  }
  if (-not $SignTool -or -not (Test-Path -LiteralPath $SignTool -PathType Leaf)) { throw 'signtool.exe not found. Install the Windows SDK signing tools or pass -SignTool.' }
  if (-not $Dlib) {
    $Dlib = Find-First @("$env:LOCALAPPDATA\Microsoft\MicrosoftArtifactSigningClientTools\Azure.CodeSigning.Dlib.dll", "$env:LOCALAPPDATA\Microsoft\Microsoft.Azure.ArtifactSigningClientTools\Azure.CodeSigning.Dlib.dll", "$env:LOCALAPPDATA\Microsoft\Windows Kits\Azure.CodeSigning.Dlib.dll", "$env:ProgramFiles\Microsoft\*ArtifactSigningClientTools*\Azure.CodeSigning.Dlib.dll", "$env:LOCALAPPDATA\Microsoft\WinGet\Packages\*ArtifactSigningClientTools*\bin\x64\Azure.CodeSigning.Dlib.dll")
  }
  if (-not $Dlib -or -not (Test-Path -LiteralPath $Dlib -PathType Leaf)) { throw 'Azure.CodeSigning.Dlib.dll not found. Install the Artifact Signing Client Tools or pass -Dlib.' }
  $loaded = @{}
  foreach ($line in [IO.File]::ReadAllLines($EnvFile)) {
    $trimmed = $line.Trim()
    if (-not $trimmed -or $trimmed.StartsWith('#')) { continue }
    $eq = $trimmed.IndexOf('=')
    if ($eq -lt 1) { continue }
    $key = $trimmed.Substring(0, $eq).Trim()
    if ($names -notcontains $key) { continue }
    $loaded[$key] = $trimmed.Substring($eq + 1).Trim().Trim('"').Trim("'")
  }
  foreach ($key in $names) {
    if (-not $loaded[$key]) { throw "The env file does not set $key." }
    [Environment]::SetEnvironmentVariable($key, $loaded[$key], 'Process')
  }
  & $SignTool sign /v /fd SHA256 /tr $TimestampUrl /td SHA256 /dlib $Dlib /dmdf $Metadata $File
  if ($LASTEXITCODE -ne 0) { throw "signtool sign failed with exit code $LASTEXITCODE" }
  & $SignTool verify /pa /v $File
  if ($LASTEXITCODE -ne 0) { throw "signtool verify failed with exit code $LASTEXITCODE" }
  exit 0
} catch {
  [Console]::Error.WriteLine("sign-windows: $($_.Exception.Message)")
  exit 1
} finally {
  foreach ($key in $names) { [Environment]::SetEnvironmentVariable($key, $null, 'Process') }
}
