// CodexBWAI — explicit NSIS payload ownership and draft/approved-terms boundary.
import { createHash } from 'node:crypto';
import path from 'node:path';
import { directoryValidation } from './directory-validation.mjs';
export const NSIS_VERSION = '3.13';
export const NSIS_SHA256 = 'ba63dffc4410ee89193e1cb5a41989991bd77c61068da17e3156d136b7b0b3d8';
export const NSIS_SOURCE = 'https://downloads.sourceforge.net/project/nsis/NSIS%203/3.13/nsis-3.13.zip';
export function nsisLiteral(value) {
  if (typeof value !== 'string' || /[\r\n\0]/.test(value)) throw new Error('Invalid NSIS literal.');
  return value.replaceAll('$', () => '$$').replaceAll('"', '$\\"');
}
export function validatePayload(files) {
  const seen = new Set();
  for (const file of files) {
    if (typeof file !== 'string' || !file || file.includes('\\') || file.startsWith('/') || file.split('/').some(p => !p || p === '.' || p === '..' || /[<>:"|?*\x00-\x1f]/.test(p) || /[. ]$/.test(p)) || seen.has(file.toLowerCase())) throw new Error('Invalid or duplicate Windows payload path.');
    if (['uninstall.exe', 'install-options.ini'].includes(file.toLowerCase())) throw new Error('Payload cannot supply installer-owned files.');
    seen.add(file.toLowerCase());
  }
  if (!seen.has('blastcast.exe')) throw new Error('Payload must contain BlastCast.exe.');
}
export function validateTerms({ mode, terms, approval, fixture }) {
  const sha256 = createHash('sha256').update(terms).digest('hex');
  if (mode === 'review') {
    if (fixture !== true || !terms.includes('DRAFT — REVIEW ONLY')) throw new Error('Review builds require a draft fixture, never the application payload.');
  } else if (mode === 'release') {
    if (terms.includes('DRAFT') || approval?.status !== 'approved' || approval.approvedBy !== 'einh' || approval.sha256 !== sha256 || !approval.approvedAt) throw new Error('Release requires owner-approved exact terms; drafts cannot ship.');
  } else throw new Error('Choose review or release mode.');
  return sha256;
}
export function renderWizard({ files, payload, output, icon, termsFile, version, mode }) {
  validatePayload(files);
  if (!/^\d{1,3}\.\d{1,3}\.\d{1,5}$/.test(version)) throw new Error('A three-part product version is required.');
  const dirs = [...new Set(files.map(f => path.posix.dirname(f)).filter(d => d !== '.'))];
  for (const dir of [...dirs]) { let parent = path.posix.dirname(dir); while (parent !== '.') { if (!dirs.includes(parent)) dirs.push(parent); parent = path.posix.dirname(parent); } }
  dirs.sort((a, b) => b.split('/').length - a.split('/').length || b.localeCompare(a));
  const ownedFiles = files.map(file => `Delete "$INSTDIR\\${nsisLiteral(file.replaceAll('/', '\\'))}"`).join('\n');
  const removeDirs = dirs.map(dir => `RMDir "$INSTDIR\\${nsisLiteral(dir.replaceAll('/', '\\'))}"`).join('\n');
  const copy = files.map(file => `SetOutPath "$INSTDIR${path.posix.dirname(file) === '.' ? '' : '\\' + nsisLiteral(path.posix.dirname(file).replaceAll('/', '\\'))}"\nFile "${nsisLiteral(path.win32.join(payload, ...file.split('/')))}"\nIfErrors install_failed`).join('\n');
  const review = mode === 'review';
  const script = `; CodexBWAI. Generated from explicit payload ownership; NSIS ${NSIS_VERSION}, zlib only.
Unicode true
!include "MUI2.nsh"
!include "LogicLib.nsh"
!include "x64.nsh"
!include "WinVer.nsh"
!include "FileFunc.nsh"
!include "nsDialogs.nsh"
Var DesktopChoice
Var StartMenuChoice
Var DesktopCheckbox
Var StartMenuCheckbox
Var ShortcutDialog
Var FailedOperation
Var AppFolderCreated
Var StartFolderCreated
SetCompressor /SOLID zlib
Name "BlastCast${review ? ' REVIEW ONLY' : ''}"
OutFile "${nsisLiteral(output)}"
InstallDir "$PROGRAMFILES64\\BlastCast"
RequestExecutionLevel admin
ManifestDPIAware true
VIProductVersion "${version}.0"
VIAddVersionKey /LANG=1033 "ProductName" "BlastCast"
VIAddVersionKey /LANG=1033 "CompanyName" "BlastworksAI"
VIAddVersionKey /LANG=1033 "FileDescription" "BlastCast ${review ? 'non-installing wizard review fixture' : 'Setup'}"
VIAddVersionKey /LANG=1033 "FileVersion" "${version}"
VIAddVersionKey /LANG=1033 "LegalCopyright" "BlastworksAI; NSIS contributors"
!define MUI_ICON "${nsisLiteral(icon)}"
!define MUI_UNICON "${nsisLiteral(icon)}"
!define MUI_ABORTWARNING
!define MUI_LICENSEPAGE_CHECKBOX
!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_LICENSE "${nsisLiteral(termsFile)}"
Page custom ShortcutOptions ShortcutOptionsLeave
!define MUI_PAGE_CUSTOMFUNCTION_LEAVE ValidateDestination
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_UNPAGE_FINISH
!insertmacro MUI_LANGUAGE "English"
Function .onInit
StrCpy $DesktopChoice 0
StrCpy $StartMenuChoice 1
SetRegView 64
SetShellVarContext all
IfSilent silent_not_supported interactive_setup
silent_not_supported:
SetErrorLevel 2
Abort
interactive_setup:
\${IfNot} \${RunningX64}
MessageBox MB_OK|MB_ICONSTOP "BlastCast requires 64-bit Windows."
Abort
\${EndIf}
\${IfNot} \${AtLeastWin10}
MessageBox MB_OK|MB_ICONSTOP "BlastCast requires Windows 10 or newer."
Abort
\${EndIf}
${review ? '; Draft fixture deliberately performs no legacy migration or installation.' : `System::Call 'msi::MsiEnumRelatedProductsW(w "{DE7E33C1-3691-4CE6-9D43-43630DC6B581}", i 0, i 0, w .r0) i .r1'
StrCmp $1 259 legacy_clear
StrCmp $1 0 legacy_found
MessageBox MB_OK|MB_ICONSTOP "BlastCast could not safely check for an older MSI installation. Setup will stop."
Abort
legacy_found:
MessageBox MB_OK|MB_ICONINFORMATION "An earlier BlastCast MSI installation is present. Remove BlastCast in Windows Settings > Apps first, then run this setup again. Keep your recordings and profile; setup does not remove them."
Abort
legacy_clear:
ReadRegStr $0 HKLM "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\BlastCast" "UninstallString"
StrCmp $0 "" nsis_clear
MessageBox MB_OK|MB_ICONINFORMATION "BlastCast is already installed. Remove its application through Windows Settings > Apps before installing this version. Recordings and your profile are preserved."
Abort
nsis_clear:`}
FunctionEnd
Function ShortcutOptions
!insertmacro MUI_HEADER_TEXT "Shortcuts" "Choose how to open BlastCast."
nsDialogs::Create 1018
Pop $ShortcutDialog
StrCmp $ShortcutDialog error 0 +2
Abort
\${NSD_CreateCheckbox} 0 10u 100% 12u "Add Desktop Shortcut"
Pop $DesktopCheckbox
\${NSD_SetState} $DesktopCheckbox $DesktopChoice
\${NSD_CreateCheckbox} 0 34u 100% 12u "Add Start Menu Folder"
Pop $StartMenuCheckbox
\${NSD_SetState} $StartMenuCheckbox $StartMenuChoice
nsDialogs::Show
FunctionEnd
Function ShortcutOptionsLeave
\${NSD_GetState} $DesktopCheckbox $DesktopChoice
\${NSD_GetState} $StartMenuCheckbox $StartMenuChoice
${review ? '; Review never creates shortcuts.' : 'Call ValidateShortcuts'}
FunctionEnd
Function ValidateShortcuts
StrCmp $DesktopChoice 1 0 desktop_clear
IfFileExists "$DESKTOP\\BlastCast.lnk" shortcut_collision desktop_clear
desktop_clear:
StrCmp $StartMenuChoice 1 0 shortcuts_clear
Push "$SMPROGRAMS\\BlastCast"
Call DirectoryState
Pop $0
StrCmp $0 0 shortcuts_clear
StrCmp $0 3 shortcuts_clear shortcut_collision
shortcut_collision:
MessageBox MB_OK|MB_ICONSTOP "A selected shortcut exists, or its Start Menu folder is not empty or cannot be inspected. Turn that option off or resolve the existing shortcut before continuing. Setup will not overwrite it."
Abort
shortcuts_clear:
FunctionEnd
Function ValidateDestination
Push "$INSTDIR"
Call DirectoryState
Pop $0
StrCmp $0 0 destination_ok
StrCmp $0 3 destination_ok
StrCmp $0 2 unreadable_destination
System::Call 'shlwapi::PathIsRootW(w "$INSTDIR") i.r0'
StrCmp $0 0 0 root_destination
System::Call 'kernel32::GetFileAttributesW(w "$INSTDIR\\Uninstall.exe") i.r0'
StrCmp $0 -1 other_destination_conflict
IntOp $0 $0 & 16
StrCmp $0 0 previous_uninstaller other_destination_conflict
previous_uninstaller:
MessageBox MB_OK|MB_ICONSTOP "Installation is blocked because this folder contains Uninstall.exe.$\\r$\\n$\\r$\\nRun the previous BlastCast uninstaller at:$\\r$\\n$INSTDIR\\Uninstall.exe$\\r$\\n$\\r$\\nThen try setup again, or choose another folder. Existing files have not been changed."
Abort
root_destination:
MessageBox MB_OK|MB_ICONSTOP "A drive root cannot be used as the application folder. Choose a folder such as C:\\Program Files\\BlastCast."
Abort
other_destination_conflict:
MessageBox MB_OK|MB_ICONSTOP "This destination contains existing files or is not a regular folder. Choose an empty application folder. Existing files will not be overwritten."
Abort
unreadable_destination:
MessageBox MB_OK|MB_ICONSTOP "Setup cannot inspect this folder. Choose another application folder."
Abort
destination_ok:
FunctionEnd
${directoryValidation()}
${review ? '' : installRecovery()}
Section "BlastCast"
${review ? 'DetailPrint "DRAFT REVIEW ONLY: no application files, shortcuts or registry entries were installed."\nSetAutoClose false' : `SetRegView 64
SetShellVarContext all
SetOverwrite try
Call ValidateShortcuts
Call ValidateDestination
Push "$INSTDIR"
Call DirectoryState
Pop $AppFolderCreated
SetOutPath "$INSTDIR"
WriteUninstaller "$INSTDIR\\Uninstall.exe"
IfErrors install_failed
StrCmp $AppFolderCreated 0 0 app_folder_preexisting
WriteINIStr "$INSTDIR\\install-options.ini" "Folders" "AppCreated" "1"
IfErrors install_failed
app_folder_preexisting:
${copy}
SetOutPath "$INSTDIR"
IfErrors install_failed
StrCmp $DesktopChoice 1 0 desktop_not_selected
CreateShortcut "$DESKTOP\\BlastCast.lnk" "$INSTDIR\\BlastCast.exe" "" "$INSTDIR\\BlastCast.exe" 0
IfErrors install_failed
WriteINIStr "$INSTDIR\\install-options.ini" "Shortcuts" "DesktopCreated" "1"
IfErrors install_failed
desktop_not_selected:
StrCmp $StartMenuChoice 1 0 startmenu_not_selected
Push "$SMPROGRAMS\\BlastCast"
Call DirectoryState
Pop $StartFolderCreated
CreateDirectory "$SMPROGRAMS\\BlastCast"
IfErrors install_failed
StrCmp $StartFolderCreated 0 0 start_folder_preexisting
WriteINIStr "$INSTDIR\\install-options.ini" "Shortcuts" "StartFolderCreated" "1"
IfErrors install_failed
start_folder_preexisting:
CreateShortcut "$SMPROGRAMS\\BlastCast\\BlastCast.lnk" "$INSTDIR\\BlastCast.exe" "" "$INSTDIR\\BlastCast.exe" 0
IfErrors install_failed
WriteINIStr "$INSTDIR\\install-options.ini" "Shortcuts" "StartAppCreated" "1"
IfErrors install_failed
CreateShortcut "$SMPROGRAMS\\BlastCast\\Uninstall BlastCast.lnk" "$INSTDIR\\Uninstall.exe" "" "$INSTDIR\\BlastCast.exe" 0
IfErrors install_failed
WriteINIStr "$INSTDIR\\install-options.ini" "Shortcuts" "StartUninstallCreated" "1"
IfErrors install_failed
startmenu_not_selected:
WriteRegStr HKLM "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\BlastCast" "DisplayName" "BlastCast"
WriteRegStr HKLM "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\BlastCast" "DisplayVersion" "${version}"
WriteRegStr HKLM "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\BlastCast" "Publisher" "BlastworksAI"
WriteRegStr HKLM "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\BlastCast" "DisplayIcon" '$\\"$INSTDIR\\BlastCast.exe$\\"'
WriteRegStr HKLM "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\BlastCast" "InstallLocation" "$INSTDIR"
WriteRegStr HKLM "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\BlastCast" "UninstallString" '$\\"$INSTDIR\\Uninstall.exe$\\"'
WriteRegDWORD HKLM "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\BlastCast" "NoModify" 1
WriteRegDWORD HKLM "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\BlastCast" "NoRepair" 1
IfErrors install_failed
install_complete:`}
SectionEnd
Section "Uninstall"
${review ? '; Review fixture never installs an uninstaller.' : `SetRegView 64
SetShellVarContext all
${ownedFiles}
ReadINIStr $0 "$INSTDIR\\install-options.ini" "Shortcuts" "DesktopCreated"
StrCmp $0 1 0 no_desktop_removal
Delete "$DESKTOP\\BlastCast.lnk"
no_desktop_removal:
ReadINIStr $0 "$INSTDIR\\install-options.ini" "Shortcuts" "StartAppCreated"
StrCmp $0 1 0 no_start_app_removal
Delete "$SMPROGRAMS\\BlastCast\\BlastCast.lnk"
no_start_app_removal:
ReadINIStr $0 "$INSTDIR\\install-options.ini" "Shortcuts" "StartUninstallCreated"
StrCmp $0 1 0 no_start_uninstall_removal
Delete "$SMPROGRAMS\\BlastCast\\Uninstall BlastCast.lnk"
no_start_uninstall_removal:
ReadINIStr $0 "$INSTDIR\\install-options.ini" "Shortcuts" "StartFolderCreated"
StrCmp $0 1 0 no_start_folder_removal
RMDir "$SMPROGRAMS\\BlastCast"
no_start_folder_removal:
ReadINIStr $AppFolderCreated "$INSTDIR\\install-options.ini" "Folders" "AppCreated"
Delete "$INSTDIR\\install-options.ini"
Delete "$INSTDIR\\Uninstall.exe"
${removeDirs}
StrCmp $AppFolderCreated 1 0 app_folder_preserved
RMDir "$INSTDIR"
app_folder_preserved:
DeleteRegKey HKLM "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\BlastCast"`}
SectionEnd
`;
  return review ? script : checkedInstallWrites(script);
}

// NSIS license pages consume RTF reliably across Windows ANSI codepages.
// Encode Unicode as RTF UTF-16 escapes; never pass unmarked UTF-8 as license text.
export function termsRtf(text) {
  let body = '';
  for (const char of text.replace(/\r\n?/g, '\n').split('')) {
    const code = char.charCodeAt(0);
    if (char === '\n') body += '\\par \r\n';
    else if (char === '\\' || char === '{' || char === '}') body += '\\' + char;
    else if (code > 127) body += `\\u${code > 32767 ? code - 65536 : code}?`;
    else body += char;
  }
  return '{\\rtf1\\ansi\\deff0{\\fonttbl{\\f0 Segoe UI;}}\\uc1\\f0\\fs20 ' + body + '}';
}

// CodexBWAI: clear sticky NSIS errors before each mutation and retry only that
// operation, never restart an install over a partially populated destination.
export function checkedInstallWrites(script) {
  let active = false, step = 0;
  return script.split('\n').flatMap(line => {
    if (line === 'Section "BlastCast"') active = true;
    if (line === 'SectionEnd') active = false;
    if (!active) return [line];
    if (line === 'IfErrors install_failed') return [];
    const command = /^(SetOutPath|WriteUninstaller|File|CreateShortcut|CreateDirectory|WriteINIStr|WriteRegStr|WriteRegDWORD)\s/.exec(line)?.[1];
    if (!command) return [line];
    const description = { SetOutPath:'prepare the installation folder', WriteUninstaller:'write the uninstaller', File:'write an application file', CreateShortcut:'create a shortcut', CreateDirectory:'create the Start Menu folder', WriteINIStr:'save installation settings', WriteRegStr:'register BlastCast', WriteRegDWORD:'register BlastCast' }[command];
    const label = `write_${++step}`;
    return [`${label}:`, 'ClearErrors', line, `IfErrors 0 ${label}_done`, `StrCpy $FailedOperation "${description}"`, 'Call RecoverInstallFailure', `Goto ${label}`, `${label}_done:`];
  }).join('\n');
}
export function installRecovery() {
  return `Function RecoverInstallFailure
Push $0
Push $1
MessageBox MB_YESNO|MB_ICONEXCLAMATION|MB_DEFBUTTON2 "Setup could not $FailedOperation.$\\r$\\n$\\r$\\nDo you want to end any running BlastCast processes and try again?$\\r$\\nThis stops active calls and recordings. Unsaved work may be lost.$\\r$\\n$\\r$\\nYes: end BlastCast processes and retry. No: exit setup." IDYES stop_blastcast
SetErrorLevel 1602
Quit
stop_blastcast:
nsExec::ExecToStack /TIMEOUT=10000 '"$SYSDIR\\taskkill.exe" /F /IM BlastCast.exe'
Pop $0
Pop $1
StrCmp $0 0 recovery_done
StrCmp $0 128 recovery_done
MessageBox MB_OK|MB_ICONSTOP "Setup could not stop BlastCast processes. Setup will exit; close BlastCast yourself before trying again. Your saved recordings are retained."
SetErrorLevel 1
Quit
recovery_done:
Pop $1
Pop $0
FunctionEnd
`;
}
