// CodexBWAI — bounded native NSIS error-flag reproduction; temporary files only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { nsisLiteral, checkedInstallWrites, installRecovery } from '../packaging/windows/wizard-plan.mjs';
const compiler = process.env.BCAST_NSIS_COMPILER;
const enabled = process.platform === 'win32' && Boolean(compiler);
test('native stale flag falsely fails a successful uninstaller write; clearing it repairs the check', { skip: !enabled }, async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'blastcast-errorflag-'));
  const observations = [];
  for (const cleared of [false, true]) {
    const label = cleared ? 'cleared' : 'stale';
    const target = path.join(root, label); await mkdir(target);
    const executable = path.join(root, label + '.exe'); const script = path.join(root, label + '.nsi');
    const source = `Unicode true
RequestExecutionLevel user
SetCompressor zlib
Name "TEMP ONLY NSIS ERRORFLAG TEST"
OutFile "${nsisLiteral(executable)}"
InstallDir "${nsisLiteral(target)}"
SilentInstall silent
Section
SetOutPath "$INSTDIR"
; Read-only fixture: this fresh UUID/path registry key is never written.
ReadRegStr $0 HKCU "Software\\BlastCastErrorFlagFixture\\${nsisLiteral(path.basename(root))}" "Missing"
${cleared ? 'ClearErrors' : '; Preserve the missing-value error exactly as the broken setup did.'}
WriteUninstaller "$INSTDIR\\Uninstall.exe"
IfErrors error_seen no_error
error_seen:
SetErrorLevel 20
Quit
no_error:
SetErrorLevel 0
Quit
SectionEnd
Section "Uninstall"
; Never executed. This fixture uninstaller deliberately deletes nothing.
SectionEnd
`;
    await writeFile(script, source);
    const compile = spawnSync(compiler, ['/NOCD', '/V4', script], { encoding: 'utf8', timeout: 30_000 });
    assert.equal(compile.status, 0, compile.stderr + compile.stdout);
    const run = spawnSync(executable, ['/S'], { encoding: 'utf8', timeout: 10_000 });
    const created = await stat(path.join(target, 'Uninstall.exe'));
    assert.ok(created.isFile() && created.size > 0);
    observations.push({ label, exitCode: run.status, uninstallerBytes: created.size });
    assert.equal(run.status, cleared ? 0 : 20, `${label}: ${run.error?.message ?? run.stderr}`);
  }
  await writeFile(path.join(root, 'report.json'), JSON.stringify({ author: 'CodexBWAI', root, observations, productInstalled: false, registryWrites: false, uninstallerExecuted: false }, null, 2));
  console.log(`Native error-flag evidence: ${root}`);
});

test('native real write failure can retry after its temporary obstruction is preserved elsewhere', { skip: !enabled }, async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'blastcast-write-retry-'));
  const target = path.join(root, 'target'); await mkdir(target);
  await mkdir(path.join(target, 'Uninstall.exe')); // A directory cannot be overwritten by an executable.
  const executable = path.join(root, 'retry.exe'); const script = path.join(root, 'retry.nsi');
  await writeFile(script, `Unicode true
RequestExecutionLevel user
SetCompressor zlib
Name "TEMP ONLY NSIS WRITE RETRY TEST"
OutFile "${nsisLiteral(executable)}"
InstallDir "${nsisLiteral(target)}"
SilentInstall silent
Section
SetOutPath "$INSTDIR"
ClearErrors
WriteUninstaller "$INSTDIR\\Uninstall.exe"
IfErrors expected_failure
SetErrorLevel 21
Quit
expected_failure:
; Preserve this fixture-only obstruction. Do not delete anything or kill processes.
ClearErrors
Rename "$INSTDIR\\Uninstall.exe" "$INSTDIR\\obstruction-preserved"
IfErrors unexpected_failure
ClearErrors
WriteUninstaller "$INSTDIR\\Uninstall.exe"
IfErrors unexpected_failure
SetErrorLevel 0
Quit
unexpected_failure:
SetErrorLevel 22
Quit
SectionEnd
Section "Uninstall"
SectionEnd
`);
  const compile = spawnSync(compiler, ['/NOCD', '/V4', script], { encoding: 'utf8', timeout: 30_000 });
  assert.equal(compile.status, 0, compile.stderr + compile.stdout);
  const run = spawnSync(executable, ['/S'], { encoding: 'utf8', timeout: 10_000 });
  assert.equal(run.status, 0, run.error?.message ?? run.stderr);
  assert.ok((await stat(path.join(target, 'Uninstall.exe'))).isFile());
  assert.ok((await stat(path.join(target, 'obstruction-preserved'))).isDirectory());
  await writeFile(path.join(root, 'report.json'), JSON.stringify({ author: 'CodexBWAI', root, genuineWriteFailureObserved: true, retryExitCode: run.status, obstructionPreserved: true, productInstalled: false, processesKilled: false }, null, 2));
  console.log(`Native write-retry evidence: ${root}`);
});

test('production write recovery retries only failed operation on Yes and exits untouched on No', { skip: !enabled }, async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'blastcast-production-retry-'));
  const observations = [];
  for (const choice of ['yes', 'no']) {
    const target = path.join(root, choice); await mkdir(target);
    await mkdir(path.join(target, 'Uninstall.exe'));
    const executable = path.join(root, choice + '.exe'); const script = path.join(root, choice + '.nsi');
    let recovery = installRecovery();
    assert.equal(recovery.split('\n').filter(line => line.startsWith('nsExec::ExecToStack ')).length, 1);
    recovery = recovery.split('\n').map(line => {
      if (line.startsWith('MessageBox MB_YESNO')) return choice === 'yes' ? 'Goto stop_blastcast ; mocked Yes' : '; mocked No: fall through to the production exit';
      if (line.startsWith('nsExec::ExecToStack ')) return `; Mock termination boundary: preserve ONLY the temporary obstruction, never kill processes.
WriteINIStr "$INSTDIR\\mock-stop.ini" "Test" "Invoked" "1"
Rename "$INSTDIR\\Uninstall.exe" "$INSTDIR\\obstruction-preserved"
Push "mock output"
Push "0"`;
      if (line.startsWith('MessageBox MB_OK')) return 'DetailPrint "Mock termination failed"';
      return line;
    }).join('\n');
    assert.doesNotMatch(recovery, /taskkill|nsExec::|MessageBox/);
    const source = checkedInstallWrites(`Unicode true
RequestExecutionLevel user
SetCompressor zlib
Name "TEMP ONLY PRODUCTION RETRY FIXTURE"
OutFile "${nsisLiteral(executable)}"
InstallDir "${nsisLiteral(target)}"
SilentInstall silent
Var FailedOperation
${recovery}
Section "BlastCast"
SetOutPath "$INSTDIR"
FileOpen $0 "$INSTDIR\\before.log" a
FileWrite $0 "before-once"
FileClose $0
WriteUninstaller "$INSTDIR\\Uninstall.exe"
IfErrors install_failed
WriteINIStr "$INSTDIR\\later.ini" "Test" "Reached" "1"
IfErrors install_failed
SetErrorLevel 0
Quit
SectionEnd
Section "Uninstall"
SectionEnd
`);
    assert.doesNotMatch(source, /taskkill|nsExec::|MessageBox/);
    await writeFile(script, source);
    const compile = spawnSync(compiler, ['/NOCD', '/V4', script], { encoding: 'utf8', timeout: 30_000 });
    assert.equal(compile.status, 0, compile.stderr + compile.stdout);
    const run = spawnSync(executable, ['/S'], { encoding: 'utf8', timeout: 10_000 });
    assert.equal(run.status, choice === 'yes' ? 0 : 1602, run.error?.message ?? run.stderr);
    assert.equal(await readFile(path.join(target, 'before.log'), 'utf8'), 'before-once');
    if (choice === 'yes') {
      assert.ok((await stat(path.join(target, 'Uninstall.exe'))).isFile());
      assert.ok((await stat(path.join(target, 'obstruction-preserved'))).isDirectory());
      assert.match(await readFile(path.join(target, 'mock-stop.ini'), 'utf8'), /Invoked=1/);
      assert.match(await readFile(path.join(target, 'later.ini'), 'utf8'), /Reached=1/);
    } else {
      assert.ok((await stat(path.join(target, 'Uninstall.exe'))).isDirectory());
      await assert.rejects(stat(path.join(target, 'mock-stop.ini')), { code: 'ENOENT' });
      await assert.rejects(stat(path.join(target, 'later.ini')), { code: 'ENOENT' });
    }
    observations.push({ choice, exitCode: run.status, previousOperationCount: 1, mockStopInvoked: choice === 'yes', laterOperationReached: choice === 'yes' });
  }
  await writeFile(path.join(root, 'report.json'), JSON.stringify({ author: 'CodexBWAI', root, observations, productionHelpers: ['checkedInstallWrites', 'installRecovery'], productInstalled: false, actualProcessesKilled: false }, null, 2));
  console.log(`Native production retry evidence: ${root}`);
});
