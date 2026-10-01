// CodexBWAI — native fixture compilation and branding, never executes a setup/uninstaller.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, copyFile, writeFile, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { buildWizard } from '../packaging/windows/wizard.mjs';
import { directoryValidation } from '../packaging/windows/directory-validation.mjs';
import { nsisLiteral, renderWizard } from '../packaging/windows/wizard-plan.mjs';
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const canBuild = process.platform === 'win32' && Boolean(process.env.BCAST_NSIS_ARCHIVE);
test('native NSIS fixture compiles review pages and guarded release syntax; branding preserves code', { skip: !canBuild }, async () => {
  const work = await mkdtemp(path.join(tmpdir(), 'blastcast-nsis-test-'));
  const payload = path.join(work, 'fixture'); await mkdir(payload);
  await copyFile(path.join(process.env.SystemRoot, 'System32', 'whoami.exe'), path.join(payload, 'BlastCast.exe'));
  await writeFile(path.join(payload, 'fixture-marker.json'), '{"purpose":"non-installing-nsis-review"}');
  const terms = path.join(work, 'draft.txt'); await writeFile(terms, 'DRAFT — REVIEW ONLY\nNon-installing compiler fixture, not product terms.');
  const output = path.join(work, 'review');
  const report = await buildWizard({ mode: 'review', version: '0.1.0', payload, png: process.env.BCAST_BRAND_PNG ?? path.join(root, 'assets', 'brand', 'Blastworks-Cast-256.png'), nsis: process.env.BCAST_NSIS_ARCHIVE, terms, output });
  assert.equal(report.installableApplication, false);
  assert.equal(report.nsis.compressor, 'zlib');
  const branding = JSON.parse((await readFile(path.join(output, 'branding-report.json'), 'utf8')).replace(/^\uFEFF/, ''));
  assert.equal(branding.nonResourceSectionsUnchanged, true);
  assert.equal(branding.productName, 'BlastCast');
  assert.equal(branding.companyName, 'BlastworksAI');
  assert.equal(branding.fileDescription, 'BlastCast');
  assert.notEqual(branding.beforeSha256, branding.afterSha256);
  const files = await readdir(path.join(output, 'payload'));
  // Compile all release instructions against this tiny fixture, with unconditional
  // startup Abort. This is not approved terms, a product build or an install test.
  const syntaxOutput = path.join(output, 'REVIEW-RELEASE-SYNTAX-NEVER-INSTALL.exe');
  let script = renderWizard({ mode: 'release', version: '0.1.0', files, payload: path.join(output, 'payload'), output: syntaxOutput, icon: path.join(output, 'BlastCast.ico'), termsFile: terms });
  script = script.replace('Name "BlastCast"', 'Name "NON-INSTALLING RELEASE SYNTAX FIXTURE"').replace('Function .onInit\n', 'Function .onInit\nAbort ; TEST FIXTURE: never install\n');
  const scriptFile = path.join(output, 'release-syntax-fixture.nsi'); await writeFile(scriptFile, script);
  const compile = spawnSync(path.join(output, 'toolchain', 'nsis-3.13', 'makensis.exe'), ['/NOCD', '/V4', scriptFile], { encoding: 'utf8', timeout: 30_000 });
  assert.equal(compile.status, 0, compile.stderr + compile.stdout);
  // Execute only the same native directory probe used by setup. No setup section,
  // registry write, shortcut or deletion is reachable in this read-only checker.
  const empty = path.join(work, 'empty'); const full = path.join(work, 'full'); const hidden = path.join(work, 'hidden');
  await Promise.all([mkdir(empty), mkdir(full), mkdir(hidden)]);
  await writeFile(path.join(full, 'visible.txt'), 'keep');
  await writeFile(path.join(hidden, 'hidden.txt'), 'keep hidden');
  const attributes = spawnSync(path.join(process.env.SystemRoot, 'System32', 'attrib.exe'), ['+H', '+S', path.join(hidden, 'hidden.txt')], { encoding: 'utf8' });
  assert.equal(attributes.status, 0, attributes.stderr);
  const cases = [[path.join(work, 'missing'), 0], [empty, 3], [full, 1], [hidden, 1], [path.parse(work).root, 1], [path.join(full, 'visible.txt'), 1]];
  const checker = path.join(output, 'READ-ONLY-DIRECTORY-CHECK.exe');
  const checkerSource = path.join(output, 'directory-check.nsi');
  await writeFile(checkerSource, `Unicode true\nRequestExecutionLevel user\nSetCompressor zlib\nOutFile "${nsisLiteral(checker)}"\n${directoryValidation()}\nFunction .onInit\n${cases.map(([folder, expected], index) => `Push "${nsisLiteral(folder)}"\nCall DirectoryState\nPop $0\nStrCmp $0 ${expected} case_${index}_ok\nSetErrorLevel ${index + 10}\nQuit\ncase_${index}_ok:`).join('\n')}\nSetErrorLevel 0\nQuit\nFunctionEnd\nSection\nSectionEnd\n`);
  const checkerCompile = spawnSync(path.join(output, 'toolchain', 'nsis-3.13', 'makensis.exe'), ['/NOCD', '/V4', checkerSource], { encoding: 'utf8', timeout: 30_000 });
  assert.equal(checkerCompile.status, 0, checkerCompile.stderr + checkerCompile.stdout);
  const probe = spawnSync(checker, ['/S'], { encoding: 'utf8', timeout: 10_000 });
  assert.equal(probe.status, 0, `Directory case ${probe.status - 10} failed: ${probe.error?.message ?? probe.stderr}`);
  assert.deepEqual(await readdir(empty), []);
  assert.equal(await readFile(path.join(hidden, 'hidden.txt'), 'utf8'), 'keep hidden');
  const releaseAttempt = buildWizard({ mode: 'release', version: '0.1.0', payload, png: process.env.BCAST_BRAND_PNG ?? path.join(root, 'assets', 'brand', 'Blastworks-Cast-256.png'), nsis: process.env.BCAST_NSIS_ARCHIVE, terms, output: path.join(work, 'must-not-exist') });
  await assert.rejects(releaseAttempt, /owner-approved exact terms/); // draft input cannot use the shipping path
});
