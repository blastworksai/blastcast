// ClaudeBWAI — einh 4 Oct: setup replaces an installed BlastCast, from the Section, from an admin-only folder, with the old uninstaller run in place.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderWizard } from '../packaging/windows/wizard-plan.mjs';
const script = renderWizard({ mode: 'release', version: '0.2.4', files: ['BlastCast.exe', 'ffmpeg.dll'], payload: 'C:\\payload', output: 'C:\\out.exe', icon: 'C:\\icon.ico', termsFile: 'C:\\terms.txt' });
const lines = script.split('\n');
const block = (open, close) => { const a = lines.indexOf(open); assert.ok(a >= 0, open); return lines.slice(a, lines.indexOf(close, a)); };
const onInit = block('Function .onInit', 'FunctionEnd');
const section = block('Section "BlastCast"', 'SectionEnd');
const validate = block('Function ValidateDestination', 'FunctionEnd');
const at = (arr, re) => arr.findIndex(l => re.test(l));

test('the unconditional "already installed" abort is gone and the replace prompt carries einh\'s exact text', () => {
  const prompt = onInit.find(l => /MB_OKCANCEL/.test(l));
  assert.ok(prompt, 'an OK/Cancel replace prompt exists');
  assert.ok(prompt.includes('BlastCast is already installed.$\\r$\\nIt will be replaced when you click Install.$\\r$\\nYour activation, settings and recordings are kept."'));
  assert.match(prompt, /\/SD IDCANCEL/);
  const i = at(onInit, /^StrCmp \$0 "" nsis_clear$/);
  assert.ok(i >= 0);
  assert.doesNotMatch(onInit[i + 1], /^MessageBox MB_OK/);
});
test('replacement happens in the Section, never in .onInit', () => {
  assert.equal(onInit.filter(l => /ExecWait|CopyFiles|old-uninstall/.test(l)).length, 0);
  assert.equal(section.filter(l => /^ExecWait /.test(l)).length, 1);
});
test('the $PROGRAMFILES64 gate precedes the OK/Cancel prompt', () => {
  const gate = at(onInit, /^StrCmp \$3 "\$PROGRAMFILES64\\" 0 manual_upgrade$/);
  const prompt = at(onInit, /MB_OKCANCEL/);
  assert.ok(gate >= 0 && prompt > gate);
  assert.ok(onInit.some(l => /^StrLen \$2 "\$PROGRAMFILES64\\"$/.test(l)));
  assert.ok(onInit.some(l => /^manual_upgrade:$/.test(l)));
});
test('CopyFiles to $PLUGINSDIR precedes ExecWait, and _?= is last, unquoted', () => {
  const copy = at(section, /^CopyFiles \/SILENT "\$OldDir\\Uninstall\.exe" "\$PLUGINSDIR\\old-uninstall\.exe"$/);
  const exec = at(section, /^ExecWait /);
  assert.ok(copy >= 0 && exec > copy);
  assert.equal(section[exec], `ExecWait '"$PLUGINSDIR\\old-uninstall.exe" _?=$OldDir' $2`);
  assert.doesNotMatch(section[exec], /UninstallString/);
});
test('the exit code is checked straight after ExecWait and a failure stops with the removal message', () => {
  const exec = at(section, /^ExecWait /);
  assert.match(section[exec + 1], /^StrCmp \$2 0 0 replace_failed$/);
  const fail = at(section, /^replace_failed:$/);
  assert.match(section[fail + 1], /The previous BlastCast could not be removed completely\. Run its uninstaller from Windows Settings > Apps, then try again\." \/SD IDOK$/);
  assert.match(section[fail + 3], /^Abort$/);
  assert.ok(section.some(l => /^StrCmp \$0 "" 0 replace_failed$/.test(l)), 'registry key gone is verified');
  assert.ok(section.some(l => /^FindFirst /.test(l)), 'folder emptiness is verified');
});
test('EnsureBlastCastClosed runs in the Section before ExecWait; AppCreated is read before uninstalling', () => {
  const close = at(section, /^Call EnsureBlastCastClosed$/);
  const read = at(section, /^ReadINIStr \$OldAppCreated .*"AppCreated"$/);
  const exec = at(section, /^ExecWait /);
  assert.ok(close >= 0 && close < exec && read >= 0 && read < exec);
  assert.ok(section.some(l => /^StrCmp \$OldAppCreated 1 0 /.test(l)), 'AppCreated is carried into the new install');
});
test('every MessageBox on the upgrade path has an /SD default', () => {
  const boxes = [...onInit, ...section].filter(l => /^MessageBox/.test(l) && /already installed|previous BlastCast/.test(l));
  assert.equal(boxes.length, 3);
  for (const l of boxes) assert.match(l, /\/SD ID\w+/);
});
test('the empty-folder rule is skipped only when replacing and the folder is exactly the old one', () => {
  const i = at(validate, /^StrCmp \$ReplaceExisting 1 0 destination_checks$/);
  assert.ok(i >= 0);
  assert.equal(validate[i + 1], 'StrCmp $INSTDIR $OldDir destination_ok');
  assert.ok(i < at(validate, /^Push "\$INSTDIR"$/));
});
test('an InstallLocation containing ".." is refused before the OK/Cancel prompt', () => {
  const scan = at(onInit, /^StrCmp \$4 "\.\." manual_upgrade$/);
  assert.ok(scan >= 0);
  assert.ok(onInit.some(l => /^StrCpy \$4 \$1 2 \$3$/.test(l)));
  assert.ok(scan > at(onInit, /^StrCmp \$3 "\$PROGRAMFILES64\\" 0 manual_upgrade$/));
  assert.ok(scan < at(onInit, /MB_OKCANCEL/));
});

// ClaudeBWAI — einh 5 Oct: verify BEFORE deleting. A failed or partial old uninstall must leave Uninstall.exe, install-options.ini and the registry key exactly as the old uninstaller left them.
const idx = (re) => at(section, re);
const regCheck = () => idx(/^StrCmp \$0 "" 0 replace_failed$/);
const scanStart = () => idx(/^FindFirst /);
test('nothing under $OldDir is deleted before both the registry check and the folder scan', () => {
  const deletes = section.map((l, i) => [l, i]).filter(([l]) => /^Delete /.test(l));
  assert.equal(deletes.length, 2, 'exactly the two known files are deleted');
  assert.ok(deletes.some(([l]) => l === 'Delete "$OldDir\\Uninstall.exe"'));
  assert.ok(deletes.some(([l]) => l === 'Delete "$OldDir\\install-options.ini"'));
  const done = idx(/^replace_scan_done:$/);
  assert.ok(regCheck() >= 0 && scanStart() > regCheck() && done > scanStart());
  for (const [, i] of deletes) assert.ok(i > done, 'Delete comes after the scan is complete');
  assert.ok(section.every(l => !/RMDir \/r/i.test(l)));
});
test('the folder scan skips exactly Uninstall.exe and install-options.ini (plus . and ..)', () => {
  const s = scanStart(), d = idx(/^replace_scan_done:$/);
  const skips = section.slice(s, d).filter(l => /^StrCmp \$1 "[^"]+" replace_scan_next$/.test(l)).map(l => /"([^"]+)"/.exec(l)[1]).sort();
  assert.deepEqual(skips, ['.', '..', 'Uninstall.exe', 'install-options.ini']);
});
test('a failed delete after a clean scan stops with the leftovers message', () => {
  const done = idx(/^replace_scan_done:$/);
  const tail = section.slice(done, idx(/^replace_failed:$/));
  assert.ok(tail.some(l => /^IfFileExists "\$OldDir\\Uninstall\.exe" replace_leftovers$/.test(l)));
  assert.ok(tail.some(l => /^IfFileExists "\$OldDir\\install-options\.ini" replace_leftovers$/.test(l)));
});
test('two stop messages: key present points at Settings > Apps, key gone with files left names the folder', () => {
  const fail = idx(/^replace_failed:$/), left = idx(/^replace_leftovers:$/);
  assert.ok(fail >= 0 && left > fail);
  assert.match(section[fail + 1], /Windows Settings > Apps/);
  const msg = section[left + 1];
  assert.match(msg, /^MessageBox MB_OK\|MB_ICONSTOP /);
  assert.ok(msg.includes('$OldDir'), 'names the folder');
  assert.match(msg, /[Cc]lose/);
  assert.match(msg, /delete the (files|leftover)/i);
  assert.match(msg, /run setup again/i);
  assert.doesNotMatch(msg, /Settings > Apps/);
  assert.match(section[left + 3], /^Abort$/);
  assert.ok(section.some(l => l === 'Goto replace_leftovers'));
});
test('the new stop MessageBox has an /SD default and sets error level 1603', () => {
  const left = idx(/^replace_leftovers:$/);
  assert.match(section[left + 1], /\/SD IDOK$/);
  assert.equal(section[left + 2], 'SetErrorLevel 1603');
});
