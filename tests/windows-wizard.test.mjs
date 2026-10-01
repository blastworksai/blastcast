// CodexBWAI — trust-boundary and generated install/uninstall ownership checks.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { renderWizard, validatePayload, validateTerms, nsisLiteral } from '../packaging/windows/wizard-plan.mjs';
const draft = 'DRAFT — REVIEW ONLY\nNo installation.';
test('draft terms cannot become release terms or accept the real application as a review fixture', () => {
  assert.throws(() => validateTerms({ mode: 'release', terms: draft, approval: { status: 'approved', approvedBy: 'einh' } }));
  assert.throws(() => validateTerms({ mode: 'review', terms: draft, fixture: false }));
  assert.equal(validateTerms({ mode: 'review', terms: draft, fixture: true }), createHash('sha256').update(draft).digest('hex'));
  assert.throws(() => validateTerms({ mode: 'release', terms: 'Terms', approval: { status: 'approved', approvedBy: 'einh', approvedAt: 'test-only', sha256: 'wrong' } }));
});
test('Windows payload ownership rejects traversal, device paths, case collisions and an injected uninstaller', () => {
  for (const extra of ['../profile/file', 'C:/data', 'dir\\file', 'file\nDelete $APPDATA', 'Uninstall.exe', 'install-options.ini', 'blastcast.EXE', 'a/../b', 'a/']) assert.throws(() => validatePayload(['BlastCast.exe', extra]), extra);
  validatePayload(['BlastCast.exe', 'resources/app/dist/screen $name.js']);
  assert.equal(nsisLiteral('cost$0"'), 'cost$$0$\\"');
});
test('release removes exact owned paths, blocks installed MSI/NSIS and offers all wizard pages', () => {
  const script = renderWizard({ mode: 'release', version: '0.1.0', files: ['BlastCast.exe', 'resources/app/index.js'], payload: 'C:\\payload', output: 'C:\\out.exe', icon: 'C:\\icon.ico', termsFile: 'C:\\terms.txt' });
  assert.match(script, /SetCompressor \/SOLID zlib/);
  for (const page of ['WELCOME', 'LICENSE', 'DIRECTORY', 'INSTFILES', 'FINISH']) assert.match(script, new RegExp(`MUI_PAGE_${page}`));
  assert.match(script, /MsiEnumRelatedProductsW/);
  assert.doesNotMatch(script, /ExecWait|msiexec|RMDir \/r|Delete "\$APPDATA|Delete "\$LOCALAPPDATA|ExecShell/);
  assert.match(script, /Delete "\$INSTDIR\\resources\\app\\index.js"/);
  assert.match(script, /IfSilent silent_not_supported/);
  assert.match(script, /WriteUninstaller/);
});
test('draft review wizard cannot install an application or touch installation registry', () => {
  const script = renderWizard({ mode: 'review', version: '0.1.0', files: ['BlastCast.exe'], payload: 'C:\\fixture', output: 'C:\\review.exe', icon: 'C:\\icon.ico', termsFile: 'C:\\draft.txt' });
  assert.doesNotMatch(script, /\nFile |WriteUninstaller|WriteReg|DeleteReg|CreateShortcut|MsiEnumRelatedProductsW/);
  assert.match(script, /REVIEW ONLY/);
});

test('shortcut defaults, selected-option collision checks and removal follow created ownership', () => {
  const script = renderWizard({ mode: 'release', version: '0.1.1', files: ['BlastCast.exe'], payload: 'C:\\payload', output: 'C:\\out.exe', icon: 'C:\\icon.ico', termsFile: 'C:\\terms.txt' });
  assert.match(script, /StrCpy \$DesktopChoice 0/);
  assert.match(script, /StrCpy \$StartMenuChoice 1/);
  assert.match(script, /"Add Desktop Shortcut"/);
  assert.match(script, /"Add Start Menu Folder"/);
  assert.match(script, /StrCmp \$DesktopChoice 1 0 desktop_clear/);
  assert.match(script, /StrCmp \$StartMenuChoice 1 0 shortcuts_clear/);
  for (const name of ['DesktopCreated', 'StartAppCreated', 'StartUninstallCreated', 'StartFolderCreated']) {
    assert.match(script, new RegExp('WriteINIStr .*"' + name + '" "1"'));
    assert.match(script, new RegExp('ReadINIStr .*"' + name + '"'));
  }
  for (const label of ['no_desktop_removal', 'no_start_app_removal', 'no_start_uninstall_removal', 'no_start_folder_removal']) assert.ok(script.includes('StrCmp $0 1 0 ' + label));
  const shortcuts = script.split('\n').filter(line => line.startsWith('CreateShortcut'));
  assert.equal(shortcuts.length, 3);
  assert.ok(shortcuts.every(line => line.endsWith('"" "$INSTDIR\\BlastCast.exe" 0')));
  assert.match(script, /"Publisher" "BlastworksAI"/);
  assert.doesNotMatch(script, /Delete "\$SMPROGRAMS\\BlastCast.lnk"/);
});
