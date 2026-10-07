// ClaudeBWAI — einh 4 Oct: the uninstaller must close BlastCast first, report files it cannot remove, and keep its own way back.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderWizard } from '../packaging/windows/wizard-plan.mjs';
const files = ['BlastCast.exe', 'ffmpeg.dll', 'resources/app/index.js'];
const script = renderWizard({ mode: 'release', version: '0.2.4', files, payload: 'C:\\payload', output: 'C:\\out.exe', icon: 'C:\\icon.ico', termsFile: 'C:\\terms.txt' });
const lines = script.split('\n');
const start = lines.indexOf('Section "Uninstall"');
const section = lines.slice(start, lines.indexOf('SectionEnd', start));
const fn = name => { const a = lines.indexOf(`Function ${name}`); assert.ok(a >= 0, `${name} exists`); return lines.slice(a, lines.indexOf('FunctionEnd', a)); };
const idx = re => section.findIndex(l => re.test(l));

test('the running check precedes every Delete in the uninstall section', () => {
  const call = idx(/^Call un\.EnsureBlastCastClosed$/);
  assert.ok(call >= 0);
  assert.ok(section.findIndex(l => /^(Delete|RMDir|DeleteRegKey) /.test(l)) > call);
});
test('setup and un. running checks detect, ask, kill, poll and exit unchanged', () => {
  for (const name of ['EnsureBlastCastClosed', 'un.EnsureBlastCastClosed']) {
    const body = fn(name).join('\n');
    assert.match(body, /tasklist \/FI "IMAGENAME eq BlastCast\.exe" \/NH \| find \/I "BlastCast\.exe"/);
    assert.match(body, /MB_YESNO[^\n]*Close BlastCast and continue\?[^\n]*Yes: close BlastCast and continue\. No: exit without changes\./);
    assert.match(body, /taskkill\.exe" \/F \/IM BlastCast\.exe/);
    assert.match(body, /StrCmp \$0 128/);
    assert.match(body, /SetErrorLevel 1602\nQuit/);
    assert.equal((body.match(/Sleep 500/g) || []).length, 1);
    assert.match(body, /StrCmp \$2 10 /);
  }
});
test('every new MessageBox carries an /SD default', () => {
  const boxes = [...fn('EnsureBlastCastClosed'), ...fn('un.EnsureBlastCastClosed'), ...section].filter(l => l.startsWith('MessageBox'));
  assert.ok(boxes.length >= 7);
  for (const b of boxes) assert.match(b, / \/SD ID(NO|OK)/, b);
  assert.match(fn('un.EnsureBlastCastClosed').find(l => l.includes('MB_YESNO')), /\/SD IDNO/);
});
test('every owned Delete is wrapped in ClearErrors/IfErrors and counted', () => {
  for (const f of files) {
    const i = section.indexOf(`Delete "$INSTDIR\\${f.replaceAll('/', '\\')}"`);
    assert.ok(i > 0, f);
    assert.equal(section[i - 1], 'ClearErrors');
    assert.match(section[i + 1], /^IfErrors 0 del_\d+_ok$/);
    assert.match(section[i + 2], /^IntOp \$LeftCount \$LeftCount \+ 1$/);
  }
  assert.ok(section.some(l => /^IntCmp \$LeftShown 10 /.test(l)));
});
test('registry key, shortcuts and folder removal are reachable only when LeftCount is 0', () => {
  const gate = idx(/^IntCmp \$LeftCount 0 uninstall_clean$/);
  const clean = idx(/^uninstall_clean:$/);
  const done = idx(/^uninstall_done:$/);
  assert.ok(gate > 0 && clean > gate && done > clean);
  assert.equal(section[clean - 1], 'Goto uninstall_done');
  for (const re of [/^DeleteRegKey /, /^RMDir /, /^Delete "\$(DESKTOP|SMPROGRAMS)/]) {
    section.forEach((l, i) => { if (re.test(l)) assert.ok(i > clean && i < done, l); });
  }
  assert.equal(section.filter(l => /^DeleteRegKey /.test(l)).length, 1);
  assert.equal(section.filter(l => /uninstall_clean|uninstall_done/.test(l) && /^(Goto|Jump|StrCmp|IntCmp)/.test(l) && !/^IntCmp \$LeftCount 0 uninstall_clean$|^Goto uninstall_done$/.test(l)).length, 0);
});
test('Uninstall.exe and install-options.ini are deleted only in the clean branch, outside the file gate', () => {
  const clean = idx(/^uninstall_clean:$/);
  for (const t of ['$INSTDIR\\Uninstall.exe', '$INSTDIR\\install-options.ini']) {
    const i = section.indexOf(`Delete "${t}"`);
    assert.ok(i > clean, t);
    assert.notEqual(section[i - 1], 'ClearErrors');
    assert.ok(section.findIndex(l => l.includes('IfErrors') && section.indexOf(l) === i + 1) < 0);
  }
  assert.ok(idx(/ReadINIStr \$AppFolderCreated/) > clean, 'AppCreated read only on the clean path');
});
test('the leftover message names the count and files and keeps recordings', () => {
  const m = section.find(l => l.startsWith('MessageBox') && l.includes('could not remove'));
  assert.match(m, /could not remove \$LeftCount files, including:\$\\r\$\\n\$LeftNames\$\\r\$\\nClose any program using them and run the uninstaller again\. Your recordings and settings are kept\./);
});
test('invariant: every Delete/RMDir target is owned, a shortcut, the options file, the uninstaller or the app folder', () => {
  const allowed = [...files.map(f => `$INSTDIR\\${f.replaceAll('/', '\\')}`), '$INSTDIR\\Uninstall.exe', '$INSTDIR\\install-options.ini', '$DESKTOP\\BlastCast.lnk', '$SMPROGRAMS\\BlastCast\\BlastCast.lnk', '$SMPROGRAMS\\BlastCast\\Uninstall BlastCast.lnk', '$SMPROGRAMS\\BlastCast', '$INSTDIR', '$INSTDIR\\resources', '$INSTDIR\\resources\\app'];
  const targets = section.map(l => /^(?:Delete|RMDir) (.*)$/.exec(l)?.[1]).filter(Boolean);
  assert.ok(targets.length >= 8);
  for (const t of targets) { assert.doesNotMatch(t, /^\/r/); assert.ok(allowed.includes(t.replace(/^"|"$/g, '')), t); }
  assert.doesNotMatch(section.filter(l => !l.startsWith('MessageBox')).join('\n'), /RMDir \/r|APPDATA|Recordings|Videos|\$DOCUMENTS/i);
});
