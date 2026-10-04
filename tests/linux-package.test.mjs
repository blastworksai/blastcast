// ClaudeBWAI — hicolor icon sizes asserted in the package listing.
// CodexBWAI — package fixtures inspect real dpkg metadata; no system installation.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { assembleDebRoot, buildDeb, REQUIRED_APP_FILES, ICON_SIZES } from '../packaging/linux/package.mjs';
async function fixture(t) {
  const base=await fs.mkdtemp(path.join(os.tmpdir(),'blastcast-deb-test-')); t.after(()=>fs.rm(base,{recursive:true,force:true}));
  const app=path.join(base,'app'),runtime=path.join(base,'runtime'),root=path.join(base,'root');
  for(const p of REQUIRED_APP_FILES) { await fs.mkdir(path.dirname(path.join(app,p)),{recursive:true}); await fs.writeFile(path.join(app,p),'fixture'); }
  await fs.writeFile(path.join(app,'package.json'),JSON.stringify({name:'blastcast',version:'0.1.0',main:'desktop/main.cjs',devDependencies:{fake:'1'}}));
  await fs.mkdir(runtime); for(const p of ['electron','chrome-sandbox','LICENSE','LICENSES.chromium.html']) await fs.writeFile(path.join(runtime,p),'fixture',{mode:0o755});
  await fs.writeFile(path.join(runtime,'version'),'44.4.5'); return {base,app,runtime,root};
}
test('Debian artifact has application, notices, menu, root-owned sandbox and no uninstall scripts',async t=>{
  const f=await fixture(t); await assembleDebRoot(f);
  const artifact=path.join(f.base,'fixture.deb');
  const build=spawnSync('dpkg-deb',['--root-owner-group','--build',f.root,artifact],{encoding:'utf8'}); assert.equal(build.status,0,build.stderr);
  const info=spawnSync('dpkg-deb',['--field',artifact],{encoding:'utf8'}); assert.equal(info.status,0); assert.match(info.stdout,/Architecture: amd64/); assert.match(info.stdout,/Package: blastcast/);
  const listing=spawnSync('dpkg-deb',['--contents',artifact],{encoding:'utf8'}).stdout;
  assert.match(listing,/-rwsr-xr-x root\/root .*opt\/blastcast\/chrome-sandbox/);
  for(const p of ['resources/app/desktop/relay-config.cjs','LICENSES.chromium.html','usr/share/applications/blastcast.desktop','usr/bin/blastcast']) assert.ok(listing.includes(p));
  for(const n of ICON_SIZES) assert.ok(listing.includes(`usr/share/icons/hicolor/${n}x${n}/apps/blastcast.png`),`hicolor ${n}`);
  assert.ok(!listing.includes('scalable'));
  assert.deepEqual(await fs.readdir(path.join(f.root,'DEBIAN')),['control']);
  assert.equal(await fs.readFile(path.join(f.root,'usr/bin/blastcast'),'utf8'),'#!/bin/sh\nexec /opt/blastcast/blastcast "$@"\n');
  const pkg=JSON.parse(await fs.readFile(path.join(f.root,'opt/blastcast/resources/app/package.json'))); assert.equal(pkg.devDependencies,undefined);
});
test('Missing relay module and source links fail before output creation',async t=>{
  const f=await fixture(t); await fs.rm(path.join(f.app,'desktop/relay-config.cjs'));
  await assert.rejects(assembleDebRoot(f),/ENOENT/);
  await fs.symlink(path.join(f.runtime,'electron'),path.join(f.app,'desktop/relay-config.cjs'));
  await assert.rejects(assembleDebRoot(f),/regular file/);
  await assert.rejects(fs.stat(f.root),/ENOENT/);
});
test('Existing or overlapping output and contaminated runtime are refused',async t=>{
  const f=await fixture(t);
  await assert.rejects(assembleDebRoot({...f,root:path.join(f.app,'nested')}),/separate/);
  await fs.mkdir(f.root); await fs.writeFile(path.join(f.root,'recording.webm'),'preserve');
  await assert.rejects(assembleDebRoot(f),/already exists/); assert.equal(await fs.readFile(path.join(f.root,'recording.webm'),'utf8'),'preserve');
  await fs.mkdir(path.join(f.runtime,'resources/app'),{recursive:true}); await fs.writeFile(path.join(f.runtime,'resources/app/evil.js'),'bad');
  await assert.rejects(assembleDebRoot({...f,root:path.join(f.base,'newroot')}),/already contains/);
});
test('Unpinned runtime archive cannot create a distribution',async t=>{
  const f=await fixture(t),archive=path.join(f.base,'fake.zip'),output=path.join(f.base,'out'); await fs.writeFile(archive,'bad');
  await assert.rejects(buildDeb({app:f.app,archive,output}),/Unapproved Electron archive/); await assert.rejects(fs.stat(output),/ENOENT/);
});

test('the pinned localhost.run host key file is a required app file',()=>{ assert.ok(REQUIRED_APP_FILES.includes('assets/localhost-run-known-hosts.txt')); });
