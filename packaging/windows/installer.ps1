# CodexBWAI. Native Windows Installer authoring; no third-party packager or custom actions.
[CmdletBinding()]
param([Parameter(Mandatory=$true)][string]$Payload,
      [Parameter(Mandatory=$true)][string]$Output,
      [Parameter(Mandatory=$true)][string]$Version)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
if (-not [Environment]::Is64BitProcess) { throw 'Use 64-bit Windows PowerShell.' }
if ($Version -notmatch '^(\d{1,3})\.(\d{1,3})\.(\d{1,5})$' -or [int]$Matches[1] -gt 255 -or [int]$Matches[2] -gt 255 -or [int]$Matches[3] -gt 65535) { throw 'MSI version must be major.minor.build within Windows Installer limits.' }
$Payload = (Resolve-Path -LiteralPath $Payload).Path.TrimEnd('\')
$Output = [IO.Path]::GetFullPath($Output)
if (Test-Path -LiteralPath $Output) { throw 'Output already exists; select a new MSI path.' }
if ([IO.Path]::GetExtension($Output) -ne '.msi') { throw 'Output must be an .msi path.' }
if (-not (Test-Path -LiteralPath "$Payload\BlastCast.exe" -PathType Leaf)) { throw 'Missing BlastCast.exe.' }
$inventory = Get-Content -LiteralPath "$Payload\blastcast-inventory.json" -Raw | ConvertFrom-Json
if ($inventory.appVersion -ne $Version) { throw 'MSI version must match the payload inventory.' }
if ($inventory.target -ne 'win32-x64') { throw 'This MSI builder accepts the verified x64 payload only.' }
$files = @(Get-ChildItem -LiteralPath $Payload -File -Recurse | Sort-Object FullName)
if ($files.Count -eq 0 -or $files.Count -gt 32767) { throw 'Unsupported payload file count.' }
foreach ($item in @(Get-Item -LiteralPath $Payload) + @(Get-ChildItem -LiteralPath $Payload -Recurse)) {
  if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Payload reparse points are forbidden.' }
  if ($item.FullName -match '[\r\n"\x00-\x1f]' -or $item.Name -match '[|;]') { throw 'Unsupported payload name.' }
}
$work = Join-Path ([IO.Path]::GetDirectoryName($Output)) ('msi-build-' + [Guid]::NewGuid().ToString('N'))
[void][IO.Directory]::CreateDirectory($work)
function Stable-Guid([string]$name) {
  $sha = [Security.Cryptography.SHA256]::Create()
  try { $bytes = $sha.ComputeHash([Text.Encoding]::UTF8.GetBytes('BlastCast MSI x64/' + $name)); return '{' + ([Guid]::new([byte[]]$bytes[0..15])).ToString().ToUpperInvariant() + '}' } finally { $sha.Dispose() }
}
$installer = New-Object -ComObject WindowsInstaller.Installer
$db = $installer.OpenDatabase($Output, 3)
function Sql([string]$query) { try { $view = $db.OpenView($query) } catch { throw ("MSI SQL failed: " + $query + " : " + $_.Exception.Message) }; try { $view.Execute() } finally { $view.Close() } }
function Row([string]$table, [object[]]$values) {
  $record = $installer.CreateRecord($values.Count)
  for ($j=0; $j -lt $values.Count; $j++) {
    if ($null -eq $values[$j]) { continue }
    if ($values[$j] -is [int]) { $record.IntegerData($j+1) = $values[$j] } else { $record.StringData($j+1) = [string]$values[$j] }
  }
  $view = $db.OpenView('SELECT * FROM `' + $table + '`')
  try { $view.Execute(); $view.Modify(1,$record) } finally { $view.Close() }
}
Sql 'CREATE TABLE `Property` (`Property` CHAR(72) NOT NULL, `Value` CHAR(0) NOT NULL LOCALIZABLE PRIMARY KEY `Property`)'
Sql 'CREATE TABLE `Directory` (`Directory` CHAR(72) NOT NULL, `Directory_Parent` CHAR(72), `DefaultDir` CHAR(255) NOT NULL LOCALIZABLE PRIMARY KEY `Directory`)'
Sql 'CREATE TABLE `Component` (`Component` CHAR(72) NOT NULL, `ComponentId` CHAR(38), `Directory_` CHAR(72) NOT NULL, `Attributes` SHORT NOT NULL, `Condition` CHAR(255), `KeyPath` CHAR(72) PRIMARY KEY `Component`)'
Sql 'CREATE TABLE `Feature` (`Feature` CHAR(38) NOT NULL, `Feature_Parent` CHAR(38), `Title` CHAR(64) LOCALIZABLE, `Description` CHAR(255) LOCALIZABLE, `Display` SHORT, `Level` SHORT NOT NULL, `Directory_` CHAR(72), `Attributes` SHORT NOT NULL PRIMARY KEY `Feature`)'
Sql 'CREATE TABLE `FeatureComponents` (`Feature_` CHAR(38) NOT NULL, `Component_` CHAR(72) NOT NULL PRIMARY KEY `Feature_`, `Component_`)'
Sql 'CREATE TABLE `File` (`File` CHAR(72) NOT NULL, `Component_` CHAR(72) NOT NULL, `FileName` CHAR(255) NOT NULL LOCALIZABLE, `FileSize` LONG NOT NULL, `Version` CHAR(72), `Language` CHAR(20), `Attributes` SHORT, `Sequence` LONG NOT NULL PRIMARY KEY `File`)'
Sql 'CREATE TABLE `Media` (`DiskId` SHORT NOT NULL, `LastSequence` LONG NOT NULL, `DiskPrompt` CHAR(64) LOCALIZABLE, `Cabinet` CHAR(255), `VolumeLabel` CHAR(32), `Source` CHAR(72) PRIMARY KEY `DiskId`)'
Sql 'CREATE TABLE `Shortcut` (`Shortcut` CHAR(72) NOT NULL, `Directory_` CHAR(72) NOT NULL, `Name` CHAR(128) NOT NULL LOCALIZABLE, `Component_` CHAR(72) NOT NULL, `Target` CHAR(72) NOT NULL, `Arguments` CHAR(255), `Description` CHAR(255) LOCALIZABLE, `Hotkey` SHORT, `Icon_` CHAR(72), `IconIndex` SHORT, `ShowCmd` SHORT, `WkDir` CHAR(72) PRIMARY KEY `Shortcut`)'
Sql 'CREATE TABLE `Upgrade` (`UpgradeCode` CHAR(38) NOT NULL, `VersionMin` CHAR(20), `VersionMax` CHAR(20), `Language` CHAR(255), `Attributes` LONG NOT NULL, `Remove` CHAR(255), `ActionProperty` CHAR(72) NOT NULL PRIMARY KEY `UpgradeCode`, `VersionMin`, `VersionMax`, `Language`, `Attributes`)'
Sql 'CREATE TABLE `LaunchCondition` (`Condition` CHAR(255) NOT NULL, `Description` CHAR(255) NOT NULL LOCALIZABLE PRIMARY KEY `Condition`)'
foreach ($table in @('InstallExecuteSequence','InstallUISequence','AdminExecuteSequence','AdminUISequence')) { Sql ('CREATE TABLE `' + $table + '` (`Action` CHAR(72) NOT NULL, `Condition` CHAR(255), `Sequence` SHORT PRIMARY KEY `Action`)') }
$upgrade = '{DE7E33C1-3691-4CE6-9D43-43630DC6B581}'
$product = Stable-Guid ('product/' + $Version)
$properties = @{ ProductCode=$product; ProductName='BlastCast'; ProductVersion=$Version; ProductLanguage='1033'; Manufacturer='Blastworks.ai'; UpgradeCode=$upgrade; ALLUSERS='1'; INSTALLLEVEL='1'; ARPNOMODIFY='1'; ARPNOREPAIR='1'; ARPCOMMENTS='BlastCast desktop recording studio'; SecureCustomProperties='OLDERPRODUCTS;NEWERPRODUCTS'; REBOOT='ReallySuppress' }
foreach ($key in $properties.Keys) { Row 'Property' @($key,$properties[$key]) }
Row 'Directory' @('TARGETDIR',$null,'SourceDir')
Row 'Directory' @('ProgramFiles64Folder','TARGETDIR','.')
Row 'Directory' @('INSTALLDIR','ProgramFiles64Folder','BlastCast')
Row 'Directory' @('ProgramMenuFolder','TARGETDIR','.')
Row 'Feature' @('Main',$null,'BlastCast','BlastCast desktop studio',1,1,'INSTALLDIR',0)
Row 'Upgrade' @($upgrade,$null,$Version,$null,0,$null,'OLDERPRODUCTS')
Row 'Upgrade' @($upgrade,$Version,$null,$null,2,$null,'NEWERPRODUCTS')
Row 'LaunchCondition' @('Installed OR NOT NEWERPRODUCTS','A newer BlastCast version is already installed.')
# AppSearch always queries Signature, including raw registry lookups with no signature row.
Sql 'CREATE TABLE `Signature` (`Signature` CHAR(72) NOT NULL, `FileName` CHAR(255) NOT NULL, `MinVersion` CHAR(20), `MaxVersion` CHAR(20), `MinSize` LONG, `MaxSize` LONG, `MinDate` LONG, `MaxDate` LONG, `Languages` CHAR(255) PRIMARY KEY `Signature`)'
Sql 'CREATE TABLE `AppSearch` (`Property` CHAR(72) NOT NULL, `Signature_` CHAR(72) NOT NULL PRIMARY KEY `Property`, `Signature_`)'
Sql 'CREATE TABLE `RegLocator` (`Signature_` CHAR(72) NOT NULL, `Root` SHORT NOT NULL, `Key` CHAR(255) NOT NULL, `Name` CHAR(255), `Type` SHORT PRIMARY KEY `Signature_`)'
Row 'RegLocator' @('WindowsMajor',2,'SOFTWARE\Microsoft\Windows NT\CurrentVersion','CurrentMajorVersionNumber',18)
Row 'AppSearch' @('WINDOWSMAJOR','WindowsMajor')
Row 'LaunchCondition' @('VersionNT64 AND WINDOWSMAJOR = "#10"','BlastCast requires 64-bit Windows 10 or Windows 11.')
Sql 'CREATE TABLE `TextStyle` (`TextStyle` CHAR(72) NOT NULL, `FaceName` CHAR(32) NOT NULL, `Size` SHORT NOT NULL, `Color` LONG, `StyleBits` SHORT PRIMARY KEY `TextStyle`)'
Sql 'CREATE TABLE `Dialog` (`Dialog` CHAR(72) NOT NULL, `HCentering` SHORT NOT NULL, `VCentering` SHORT NOT NULL, `Width` SHORT NOT NULL, `Height` SHORT NOT NULL, `Attributes` LONG NOT NULL, `Title` CHAR(128) LOCALIZABLE, `Control_First` CHAR(50) NOT NULL, `Control_Default` CHAR(50), `Control_Cancel` CHAR(50) PRIMARY KEY `Dialog`)'
Sql 'CREATE TABLE `Control` (`Dialog_` CHAR(72) NOT NULL, `Control` CHAR(50) NOT NULL, `Type` CHAR(20) NOT NULL, `X` SHORT NOT NULL, `Y` SHORT NOT NULL, `Width` SHORT NOT NULL, `Height` SHORT NOT NULL, `Attributes` LONG, `Property` CHAR(50), `Text` CHAR(0) LOCALIZABLE, `Control_Next` CHAR(50), `Help` CHAR(50) LOCALIZABLE PRIMARY KEY `Dialog_`, `Control`)'
Sql 'CREATE TABLE `ControlEvent` (`Dialog_` CHAR(72) NOT NULL, `Control_` CHAR(50) NOT NULL, `Event` CHAR(50) NOT NULL, `Argument` CHAR(255) NOT NULL, `Condition` CHAR(255) NOT NULL, `Ordering` SHORT PRIMARY KEY `Dialog_`, `Control_`, `Event`, `Argument`, `Condition`)'
Row 'Property' @('DefaultUIFont','Normal')
Row 'TextStyle' @('Normal','Segoe UI',9,0,0)
Row 'Dialog' @('Welcome',50,50,320,150,3,'BlastCast Setup','Install','Install','Cancel')
Row 'Control' @('Welcome','Message','Text',15,15,290,80,3,$null,'Install BlastCast for everyone on this computer. Windows will request administrator permission. To remove an existing installation, use Windows Settings > Apps.',$null,$null)
Row 'Control' @('Welcome','Install','PushButton',155,115,70,20,3,$null,'&Continue','Cancel',$null)
Row 'Control' @('Welcome','Cancel','PushButton',235,115,70,20,3,$null,'Cancel','Install',$null)
Row 'ControlEvent' @('Welcome','Install','EndDialog','Return','1',1)
Row 'ControlEvent' @('Welcome','Cancel','EndDialog','Exit','1',1)
$directories = @{ ''='INSTALLDIR' }
$ddf = [Collections.Generic.List[string]]::new()
foreach ($line in @('.OPTION EXPLICIT','.Set CabinetNameTemplate=payload.cab',('.Set InfFileName="' + $work + '\payload.inf"'),('.Set RptFileName="' + $work + '\payload.rpt"'),('.Set DiskDirectoryTemplate="' + $work + '"'),'.Set CompressionType=LZX','.Set CompressionMemory=21','.Set Cabinet=on','.Set Compress=on','.Set MaxDiskSize=0','.Set MaxCabinetSize=0','.Set MaxDiskFileCount=0','.Set FolderFileCountThreshold=0','.Set FolderSizeThreshold=0')) { $ddf.Add($line) }
$i=0
foreach ($file in $files) {
  $i++; $id = 'F' + $i.ToString('D6'); $component='C' + $i.ToString('D6')
  $relative = $file.FullName.Substring($Payload.Length+1)
  $parent = [IO.Path]::GetDirectoryName($relative)
  $walk=''
  foreach ($part in ($parent -split '\\' | Where-Object { $_ })) {
    $previous=$walk; $walk=if ($walk) { "$walk\$part" } else { $part }
    if (-not $directories.ContainsKey($walk)) {
      $dir='D' + $directories.Count.ToString('D6')
      Row 'Directory' @($dir,$directories[$previous],($dir + '|' + $part)); $directories[$walk]=$dir
    }
  }
  Row 'Component' @($component,(Stable-Guid ('file/' + $relative.ToLowerInvariant())),$directories[$parent],256,$null,$id)
  Row 'FeatureComponents' @('Main',$component)
  $fileVersion=$installer.FileVersion($file.FullName, $false)
  $fileLanguage=$installer.FileVersion($file.FullName, $true)
  Row 'File' @($id,$component,($id + '|' + $file.Name),[int]$file.Length,$fileVersion,$fileLanguage,512,$i)
  $ddf.Add('"' + $file.FullName + '" ' + $id)
  if ($relative -eq 'BlastCast.exe') { Row 'Shortcut' @('BlastCastStart','ProgramMenuFolder','BlastCast',$component,('[#' + $id + ']'),$null,'BlastCast recording studio',$null,$null,$null,1,'INSTALLDIR') }
}
Row 'Media' @(1,$files.Count,$null,'#payload.cab',$null,$null)
# Remove the older version after Initialize: removal and new installation roll back together.
$execute=@(@('FindRelatedProducts',25),@('AppSearch',50),@('LaunchConditions',100),@('ValidateProductID',700),@('CostInitialize',800),@('FileCost',900),@('CostFinalize',1000),@('InstallValidate',1400),@('InstallInitialize',1500),@('RemoveExistingProducts',1510),@('ProcessComponents',1600),@('UnpublishFeatures',1800),@('RemoveShortcuts',3200),@('RemoveFiles',3500),@('RemoveFolders',3600),@('InstallFiles',4000),@('CreateShortcuts',4500),@('RegisterUser',6000),@('RegisterProduct',6100),@('PublishFeatures',6300),@('PublishProduct',6400),@('InstallFinalize',6600))
foreach ($action in $execute) { Row 'InstallExecuteSequence' @($action[0],$null,[int]$action[1]) }
foreach ($action in @(@('FindRelatedProducts',25),@('AppSearch',50),@('LaunchConditions',100),@('CostInitialize',800),@('FileCost',900),@('CostFinalize',1000),@('Welcome',1200),@('ExecuteAction',1300))) { $condition=if ($action[0] -eq 'Welcome') { 'NOT Installed' } else { $null }; Row 'InstallUISequence' @($action[0],$condition,[int]$action[1]) }
foreach ($action in @(@('CostInitialize',800),@('FileCost',900),@('CostFinalize',1000),@('InstallValidate',1400),@('InstallInitialize',1500),@('InstallAdminPackage',3900),@('InstallFiles',4000),@('InstallFinalize',6600))) { Row 'AdminExecuteSequence' @($action[0],$null,[int]$action[1]) }
foreach ($action in @(@('CostInitialize',800),@('FileCost',900),@('CostFinalize',1000),@('ExecuteAction',1300))) { Row 'AdminUISequence' @($action[0],$null,[int]$action[1]) }
$ddfPath=Join-Path $work 'payload.ddf'
[IO.File]::WriteAllLines($ddfPath,$ddf,[Text.Encoding]::Default)
& "$env:SystemRoot\System32\makecab.exe" /F $ddfPath *> (Join-Path $work 'makecab.log')
if ($LASTEXITCODE -ne 0) { throw 'makecab failed.' }
$cabRecord=$installer.CreateRecord(2); $cabRecord.StringData(1)='payload.cab'; $cabRecord.SetStream(2,(Join-Path $work 'payload.cab'))
$view=$db.OpenView('INSERT INTO `_Streams` (`Name`,`Data`) VALUES (?,?)'); $view.Execute($cabRecord); $view.Close()
$summary=$db.SummaryInformation(20)
$summary.Property(1)=1252; $summary.Property(2)='BlastCast Installer'; $summary.Property(3)='BlastCast desktop studio'; $summary.Property(4)='CodexBWAI / Blastworks.ai'; $summary.Property(7)='x64;1033'; $summary.Property(9)='{' + [Guid]::NewGuid().ToString().ToUpperInvariant() + '}'; $summary.Property(14)=500; $summary.Property(15)=2; $summary.Property(18)='CodexBWAI native MSI builder'; $summary.Persist()
$db.Commit()
foreach ($com in @($summary,$view,$cabRecord,$db,$installer)) { [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($com) }
[GC]::Collect(); [GC]::WaitForPendingFinalizers()
$report=@{ author='CodexBWAI'; output=$Output; version=$Version; productCode=$product; upgradeCode=$upgrade; files=$files.Count; sha256=(Get-FileHash -LiteralPath $Output -Algorithm SHA256).Hash.ToLowerInvariant(); signed=$false; installationPerformed=$false }
$report | ConvertTo-Json | Set-Content -LiteralPath ($Output + '.json') -Encoding UTF8
$report | ConvertTo-Json
