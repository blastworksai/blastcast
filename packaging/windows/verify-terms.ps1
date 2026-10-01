# CodexBWAI — read-only native RichEdit decoding of the installer's RTF terms.
param([Parameter(Mandatory=$true)][string]$Rtf,[Parameter(Mandatory=$true)][string]$ApprovedText)
$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.Windows.Forms
$box=New-Object System.Windows.Forms.RichTextBox
try {
  $box.Rtf=[IO.File]::ReadAllText($Rtf,[Text.Encoding]::ASCII)
  $expected=[IO.File]::ReadAllText($ApprovedText,[Text.Encoding]::UTF8).Replace("`r`n","`n").TrimEnd([char]10)
  $actual=$box.Text.Replace("`r`n","`n").TrimEnd([char]10)
  # RichEdit omits the terminal paragraph mark, but every content character and
  # internal line break must survive. Compare case-sensitively, not by culture.
  if(-not [String]::Equals($actual,$expected,[StringComparison]::Ordinal)) { throw 'Native RichEdit did not reproduce the approved terms exactly.' }
  @{author='CodexBWAI';exactContentAndLineBreaks=$true;characters=$actual.Length;title=$actual.Split("`n")[0];titleCodepoints=@($actual.Split("`n")[0].ToCharArray() | ForEach-Object { [int]$_ })} | ConvertTo-Json
} finally { $box.Dispose() }
