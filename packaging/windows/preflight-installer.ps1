# CodexBWAI. Read-only MSI preflight: never execute INSTALL, ExecuteAction or install transaction actions.
param([Parameter(Mandatory=$true)][string]$Msi)
$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest
$installer=New-Object -ComObject WindowsInstaller.Installer
$installer.UILevel=2 # No dialogs in a build/test SSH session.
$session=$installer.OpenPackage([IO.Path]::GetFullPath($Msi),1)
$results=[ordered]@{}
foreach($action in @('FindRelatedProducts','AppSearch','LaunchConditions','CostInitialize','FileCost','CostFinalize')) {
  $result=$session.DoAction($action)
  $results[$action]=$result
  if ($result -ne 1) { throw "Read-only MSI preflight $action failed with status $result." }
  if ($action -eq 'AppSearch' -and $session.Property('WINDOWSMAJOR') -ne '#10') { throw 'AppSearch did not resolve Windows major version #10.' }
}
$windowsMajor=$session.Property('WINDOWSMAJOR')
[void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($session)
$previewCreated=$false; $previewError=$null; $preview=$null
$previewDatabase=$installer.OpenDatabase([IO.Path]::GetFullPath($Msi),0)
try {
  $preview=$previewDatabase.EnableUIPreview()
  [void]$preview.ViewDialog('Welcome'); [void]$preview.ViewDialog('')
  $previewCreated=$true
} catch { $previewError=$_.Exception.Message } finally {
  if($preview) { [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($preview) }
  [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($previewDatabase)
}
$report=@{welcomePreviewCreated=$previewCreated;welcomePreviewError=$previewError;author='CodexBWAI';msi=$Msi;windowsMajor=$windowsMajor;actions=$results;installationPerformed=$false}
$report | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath ($Msi+'.preflight.json') -Encoding UTF8
if(-not $previewCreated) { throw ('Welcome UI preview failed: ' + $previewError) }
$report | ConvertTo-Json -Depth 4
