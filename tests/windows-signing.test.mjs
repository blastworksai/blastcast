// ClaudeBWAI — einh 4 Oct: Azure Artifact Signing build integration (CP3b).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { renderWizard } from '../packaging/windows/wizard-plan.mjs';
import { resolveSigning, signCommandFor, signFiles } from '../packaging/windows/wizard.mjs';
const base = { mode: 'release', version: '0.2.4', files: ['BlastCast.exe', 'resources/app/index.js'], payload: 'C:\\payload', output: 'C:\\out.exe', icon: 'C:\\icon.ico', termsFile: 'C:\\terms.txt' };
const command = '"C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -NoProfile -ExecutionPolicy RemoteSigned -File "C:\\b\\sign-windows.ps1" -Metadata "C:\\s\\m.json" -EnvFile "C:\\s\\a.env"';
const script = await readFile(new URL('../packaging/windows/sign-windows.ps1', import.meta.url), 'utf8');
const wizard = await readFile(new URL('../packaging/windows/wizard.mjs', import.meta.url), 'utf8');
test('renderWizard emits both finalize lines with a return check only when signing', () => {
  const signed = renderWizard({ ...base, signCommand: command });
  assert.match(signed, /^!uninstfinalize '.*sign-windows\.ps1.* "%1"' = 0$/m);
  assert.match(signed, /^!finalize '.*sign-windows\.ps1.* "%1"' = 0$/m);
  const unsigned = renderWizard(base);
  assert.doesNotMatch(unsigned, /finalize/);
  assert.equal(signed.replace(/^; ClaudeBWAI — einh 4 Oct: sign Setup.*\n!uninstfinalize.*\n!finalize.*\n/m, ''), unsigned);
});
test('signing inputs are all-or-nothing, absolute, and the NSIS command is quote-safe', () => {
  assert.equal(resolveSigning({}), undefined);
  assert.throws(() => resolveSigning({ signMetadata: 'C:\\m.json' }));
  assert.throws(() => resolveSigning({ signMetadata: 'm.json', signEnv: 'C:\\a.env' }));
  assert.equal(resolveSigning({ signMetadata: 'C:\\m.json', signEnv: 'C:\\a.env' }, 'C:\\here').script.endsWith('sign-windows.ps1'), true);
  assert.throws(() => signCommandFor('C:\\ps.exe', { script: "C:\\it's.ps1", metadata: 'C:\\m', env: 'C:\\e' }));
  assert.match(signCommandFor('C:\\ps.exe', { script: 'C:\\s.ps1', metadata: 'C:\\m', env: 'C:\\e' }), /-File "C:\\s\.ps1" -Metadata "C:\\m" -EnvFile "C:\\e"$/);
});
test('signFiles signs only exe, dll and node, in order, through the injected runner', () => {
  const seen = [];
  const out = signFiles(['a/BlastCast.exe', 'a/x.DLL', 'a/y.node', 'a/z.js', 'a/q.json'], f => seen.push(f));
  assert.deepEqual(seen, ['a/BlastCast.exe', 'a/x.DLL', 'a/y.node']);
  assert.deepEqual(out, seen);
  assert.throws(() => signFiles(['a.exe'], () => { throw new Error('boom'); }), /boom/);
});
test('buildWizard signs after branding and before the inventory hashes; unsigned report fields exist', () => {
  const at = s => { const i = wizard.indexOf(s); assert.ok(i > 0, s); return i; };
  assert.ok(at("'brand-executable.ps1'") < at('signFiles(await walkAbsolute(staging)'));
  assert.ok(at('signFiles(await walkAbsolute(staging)') < at('inventory.payload.push'));
  assert.ok(at("Plugins', 'x86-unicode'") < at("run(compiler, ['/NOCD'"));
  assert.match(wizard, /signed: Boolean\(sign\), signing: sign \? 'azure-artifact-signing' : 'unsigned'/);
  assert.match(wizard, /Setup upgrades an installed BlastCast for you\./);
  assert.match(wizard, /Publisher signing is pending; this build is unsigned\./);
});
test('sign-windows.ps1 keeps secrets in its own process, never prints them, verifies and exits non-zero', () => {
  assert.doesNotMatch(script, /Write-(Output|Host|Verbose|Debug)/);
  for (const key of ['AZURE_TENANT_ID', 'AZURE_CLIENT_ID', 'AZURE_CLIENT_SECRET']) assert.ok(script.includes(`'${key}'`));
  assert.doesNotMatch(script, /'(User|Machine)'|setx/i);
  assert.equal((script.match(/SetEnvironmentVariable\(/g) ?? []).length, 2);
  assert.match(script, /SetEnvironmentVariable\(\$key, \$null, 'Process'\)/);
  assert.match(script, /finally \{/);
  assert.match(script, /\/fd SHA256 \/tr \$TimestampUrl \/td SHA256 \/dlib \$Dlib \/dmdf \$Metadata \$File/);
  assert.match(script, /timestamp\.acs\.microsoft\.com/);
  assert.match(script, /verify \/pa \/v \$File/);
  assert.match(script, /LASTEXITCODE -ne 0\) \{ throw/);
  assert.match(script, /exit 1/);
});
