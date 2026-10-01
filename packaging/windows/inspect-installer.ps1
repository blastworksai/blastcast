# CodexBWAI. Read MSI tables and verify administrative extraction; no product registration.
param([Parameter(Mandatory=$true)][string]$Msi,[Parameter(Mandatory=$true)][string]$Payload,[Parameter(Mandatory=$true)][string]$Extract)
$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest
trap { Write-Error ($_.ScriptStackTrace + ' : ' + $_.Exception.Message); break }
if (Test-Path -LiteralPath $Extract) { throw 'Extraction destination must be new.' }
$installer=New-Object -ComObject WindowsInstaller.Installer
$db=$installer.OpenDatabase($Msi,0)
function ReadRows([string]$table,[int]$count) {
  $view=$db.OpenView('SELECT * FROM `' + $table + '`'); [void]$view.Execute()
  $rows=@(); while ($r=$view.Fetch()) { $row=@(); for($i=1;$i -le $count;$i++) { $row+= $r.StringData($i) }; $rows+= ,$row }; [void]$view.Close(); return ,$rows
}
$files=ReadRows 'File' 8; $components=ReadRows 'Component' 6
if ($files.Count -ne $components.Count -or $files.Count -lt 1) { throw 'Invalid file/component cardinality.' }
foreach ($row in $components) { if ($row[3] -ne '256' -or -not $row[5]) { throw 'Component lacks 64-bit flag or file key path.' } }
$properties=@{}; foreach($row in (ReadRows 'Property' 2)) { $properties[$row[0]]=$row[1] }
if ($properties.ALLUSERS -ne '1') { throw 'Not a per-machine MSI.' }
$sequence=ReadRows 'InstallExecuteSequence' 3
$required=@('RemoveExistingProducts','RemoveFiles','RemoveShortcuts','RegisterProduct','PublishProduct','InstallInitialize','InstallFinalize')
foreach($action in $required) { if (-not ($sequence | Where-Object { $_[0] -eq $action })) { throw "Missing action: $action" } }
$shortcut=ReadRows 'Shortcut' 12
$summary=$db.SummaryInformation(0)
if ($summary.Property(7) -ne 'x64;1033' -or $summary.Property(15) -ne 2) { throw 'Invalid package architecture/compression.' }
[void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($db)
$log=$Msi + '.admin-extract.log'
$process=Start-Process -FilePath "$env:SystemRoot\System32\msiexec.exe" -ArgumentList @('/a',('"'+$Msi+'"'),'/qn',('TARGETDIR="'+$Extract+'"'),'/l*v',('"'+$log+'"')) -Wait -PassThru
if ($process.ExitCode -ne 0) { throw "MSI administrative extraction failed: $($process.ExitCode); see $log" }
$executable=@(Get-ChildItem -LiteralPath $Extract -Filter BlastCast.exe -Recurse)
if ($executable.Count -ne 1) { throw 'Administrative image lacks one BlastCast executable.' }
$root=$executable[0].DirectoryName
$source=@(Get-ChildItem -LiteralPath $Payload -File -Recurse)
foreach($file in $source) {
  $relative=$file.FullName.Substring($Payload.TrimEnd('\').Length+1); $target=Join-Path $root $relative
  if (-not (Test-Path -LiteralPath $target -PathType Leaf) -or (Get-FileHash -LiteralPath $target).Hash -ne (Get-FileHash -LiteralPath $file.FullName).Hash) { throw "Administrative image mismatch: $relative" }
}
$report=@{author='CodexBWAI';msi=$Msi;sha256=(Get-FileHash -LiteralPath $Msi).Hash.ToLowerInvariant();productCode=$properties.ProductCode;fileCount=$files.Count;extractedFilesHashVerified=$source.Count;platform='x64';perMachine=$true;shortcut=$shortcut;installPerformed=$false;administrativeExtractionExitCode=$process.ExitCode}
$report | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath ($Msi+'.inspection.json') -Encoding UTF8
$report | ConvertTo-Json -Depth 6
