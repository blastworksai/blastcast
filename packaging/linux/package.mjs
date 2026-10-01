// CodexBWAI — offline Debian package builder. No root, downloads or install hooks.
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { hashFile } from '../windows/layout.mjs';
export const ELECTRON_VERSION = '44.4.5';
export const ARCHIVE_SHA256 = '04586a0ec46c3283fbdaef85530f561f71f0b5e136ad0cb9ef63683615609780';
const scenes = ['1cam','2cam','3cam','4cam','5cam','6cam','7cam','8cam','screensharevert-8','screensharehorizont-8'];
export const REQUIRED_APP_FILES = [
  'package.json','LICENSE','assets/licensing/public-key.txt','desktop/license-key.cjs','desktop/license-store.cjs',
  ...['main','preload','boundary','destination','recording','webm','guests','direct-access','relay-config','admission','signaling','sources','source-recovery','source-import','source-controller'].map(n => `desktop/${n}.cjs`),
'desktop/free-tunnel.cjs','desktop/guest-access.cjs','desktop/guest-settings.cjs','desktop/guest-wizard.cjs','dist/invite-automation.js','desktop/recording-library.cjs','desktop/studio-preferences.cjs','desktop/display-picker.cjs','dist/recording-library.js','dist/screen-share.js','dist/studio-shell.js','dist/tokens.css','dist/blastcast.css','dist/logo-icon.svg','dist/fonts/BlastworksSans-Regular.woff2','dist/fonts/BlastworksSans-SemiBold.woff2','dist/fonts/BlastworksSans-ExtraBold.woff2','dist/fonts/BlastworksSans-UNLICENSE.txt',
    ...['recording-status.js','synchronization.js','source-protocol.js','source-capture.js','source-session.js','source-outbox.js','source-recovery.js','host-calls.js','guest-call.js','peer-call.js','audio-mix.js','admission-ui.js','admission.css','scenes.js','scene-controls.js','screen-share-attention.js','program-output.js','index.html','studio.js','studio.css','invites.js','relay-input.js','recording.js','preview.js','device-access.js','camera-background.js','guest.html','guest.js','guest.css','readiness.html','readiness.js','readiness.css','package.json','Blastworks-Cast-256.png'].map(n => `dist/${n}`),
    ...['tf.min.js','body-pix.min.js','model-stride16.json','group1-shard1of1.bin','NOTICE.txt'].map(n => `dist/bodypix/${n}`),
    ...['cloudflare-tunnel-ready', 'cloudflare-route-form', 'cloudflare-route-ready', 'expressturn-fields'].map(n => `dist/instructions/${n}.png`),
  'assets/brand/Blastworks-Cast-256.png', ...scenes.flatMap(n => [`dist/${n}.png`, `assets/scenes/defaults/${n}.png`]),
];
function inside(a,b) { const r = path.relative(a,b); return r === '' || (!r.startsWith('../') && r !== '..' && !path.isAbsolute(r)); }
async function directory(p) { if (!(await fs.lstat(p)).isDirectory()) throw new Error('Expected real directory'); return fs.realpath(p); }
async function regular(p) { if (!(await fs.lstat(p)).isFile()) throw new Error(`Expected regular file: ${p}`); }
async function absent(p) { try { await fs.lstat(p); } catch(e) { if (e.code === 'ENOENT') return; throw e; } throw new Error('Output already exists'); }
async function walk(root, rel='') {
  const result=[];
  for (const name of (await fs.readdir(path.join(root,rel))).sort()) {
    const p=path.join(rel,name), s=await fs.lstat(path.join(root,p));
    if (s.isDirectory()) result.push(...await walk(root,p));
    else if(s.isFile()) result.push(p);
    else throw new Error(`Unsupported input (symlink or special file): ${p}`);
  }
  return result;
}
function run(command,args) { const r=spawnSync(command,args,{encoding:'utf8',maxBuffer:8*1024*1024}); if(r.error || r.status!==0) throw r.error ?? new Error(`${command} failed: ${r.stderr}`); return r.stdout; }
async function put(p,content,mode=0o644) { await fs.mkdir(path.dirname(p),{recursive:true}); await fs.writeFile(p,content,{mode}); await fs.chmod(p,mode); }
export async function assembleDebRoot({app,runtime,root}) {
  app=await directory(app); runtime=await directory(runtime);
  root=path.join(await directory(path.dirname(path.resolve(root))),path.basename(root));
  if ([app,runtime].some(p => inside(p,root)||inside(root,p))) throw new Error('Output must be separate from inputs');
  await absent(root);
  for(const p of REQUIRED_APP_FILES) await regular(path.join(app,p));
  const manifest=JSON.parse(await fs.readFile(path.join(app,'package.json'),'utf8'));
  if(manifest.name!=='blastcast'||manifest.main!=='desktop/main.cjs'||!/^\d+\.\d+\.\d+$/.test(manifest.version)) throw new Error('Invalid app manifest');
  for(const p of ['electron','chrome-sandbox','version','LICENSE','LICENSES.chromium.html']) await regular(path.join(runtime,p));
  if((await fs.readFile(path.join(runtime,'version'),'utf8')).trim()!==ELECTRON_VERSION) throw new Error('Wrong Electron version');
  const runtimeFiles=await walk(runtime);
  if(runtimeFiles.some(p => p==='blastcast'||/^resources\/app(?:[/.]|$)/.test(p))) throw new Error('Runtime already contains an application');
  const appFiles=['LICENSE'];
  for(const area of ['desktop','dist','assets']) { await directory(path.join(app,area)); for(const p of await walk(path.join(app,area))) if(/\.(?:cjs|js|json|html|css|png|svg|woff2|txt|bin|pem)$/i.test(p)) appFiles.push(path.join(area,p)); }
  await fs.mkdir(root,{mode:0o755});
  const target=path.join(root,'opt/blastcast');
  for(const p of runtimeFiles) {
    const dst=path.join(target,p==='electron'?'blastcast':p);
    await put(dst,await fs.readFile(path.join(runtime,p)),p==='chrome-sandbox'?0o4755:((await fs.stat(path.join(runtime,p))).mode&0o111)?0o755:0o644);
  }
  for(const p of appFiles) await put(path.join(target,'resources/app',p),await fs.readFile(path.join(app,p)));
  await put(path.join(target,'resources/app/package.json'),JSON.stringify({name:manifest.name,version:manifest.version,main:manifest.main,author:manifest.author,private:true,license:manifest.license},null,2)+'\n');
  await put(path.join(root,'usr/bin/blastcast'),'#!/bin/sh\nexec /opt/blastcast/blastcast "$@"\n',0o755);
  await put(path.join(root,'usr/share/applications/blastcast.desktop'),'[Desktop Entry]\nType=Application\nName=BlastCast\nComment=Host-owned podcast studio\nExec=/usr/bin/blastcast %U\nIcon=blastcast\nTerminal=false\nCategories=AudioVideo;Audio;Video;\nStartupWMClass=blastcast\n');
  await put(path.join(root,'usr/share/icons/hicolor/256x256/apps/blastcast.png'),await fs.readFile(path.join(app,'assets/brand/Blastworks-Cast-256.png')));
  const payload=[];
  for(const p of await walk(root)) payload.push({path:p,sha256:await hashFile(path.join(root,p)),bytes:(await fs.stat(path.join(root,p))).size});
  const inventory={publisher:'BlastworksAI',version:manifest.version,target:'linux-amd64',electronVersion:ELECTRON_VERSION,expectedArchiveSha256:ARCHIVE_SHA256,nativeAcceptance:'not-run',payload};
  await put(path.join(target,'blastcast-inventory.json'),JSON.stringify(inventory,null,2)+'\n');
  const installedSize=Math.ceil(payload.reduce((sum,p)=>sum+p.bytes,0)/1024);
  await put(path.join(root,'DEBIAN/control'),`Package: blastcast\nVersion: ${manifest.version}\nSection: sound\nPriority: optional\nArchitecture: amd64\nMaintainer: BlastworksAI <blastworksai@gmail.com>\nInstalled-Size: ${installedSize}\nDepends: libc6 (>= 2.25), libgcc-s1, libudev1, libatspi2.0-0 | libatspi2.0-0t64, libasound2 | libasound2t64, libatk1.0-0, libatk-bridge2.0-0, libcairo2, libcups2 | libcups2t64, libdbus-1-3, libdrm2, libexpat1, libgbm1, libglib2.0-0 | libglib2.0-0t64, libgtk-3-0 | libgtk-3-0t64, libnspr4, libnss3, libpango-1.0-0, libx11-6, libxcb1, libxcomposite1, libxdamage1, libxext6, libxfixes3, libxkbcommon0, libxrandr2\nDescription: BlastCast host-owned podcast studio\n Records local podcast media and hosts browser guests.\n Unsigned package; native acceptance remains pending.\n`);
  return inventory;
}
export async function buildDeb({app,archive,output}) {
  if(process.platform!=='linux') throw new Error('Build Debian packages on Linux');
  archive=path.resolve(archive); await regular(archive);
  if(await hashFile(archive)!==ARCHIVE_SHA256) throw new Error('Unapproved Electron archive; nothing extracted');
  app=await directory(app);
  output=path.join(await directory(path.dirname(path.resolve(output))),path.basename(output));
  if(inside(output,app)||['desktop','dist','assets'].some(p=>inside(path.join(app,p),output))) throw new Error('Output overlaps source');
  await absent(output);
  const stage=await fs.mkdtemp(path.join(os.tmpdir(),'blastcast-deb-'));
  try {
    const runtime=path.join(stage,'runtime'); await fs.mkdir(runtime);
    run('unzip',['-q',archive,'-d',runtime]);
    const root=path.join(stage,'root'); const inventory=await assembleDebRoot({app,runtime,root});
    await fs.mkdir(output);
    const artifact=path.join(output,`blastcast_${inventory.version}_amd64.deb`);
    run('dpkg-deb',['--root-owner-group','--build',root,artifact]);
    const report={...inventory,archiveSha256:ARCHIVE_SHA256,archiveVerification:'SHA-256 matched before extraction',artifact:path.basename(artifact),sha256:await hashFile(artifact),installation:'not performed; no root operation',sandbox:'root:root 4755 chrome-sandbox in package; no sandbox-disabling flags'};
    await put(path.join(output,'build-report.json'),JSON.stringify(report,null,2)+'\n');
    return report;
  } finally { await fs.rm(stage,{recursive:true,force:true}); }
}
if(process.argv[1] && path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  try {
    const opts={}; for(let i=2;i<process.argv.length;i+=2) { const k=process.argv[i].slice(2); if(!['app','archive','output'].includes(k)||opts[k]||!process.argv[i+1]||!process.argv[i].startsWith('--')) throw new Error('Expected --app --archive --output, each once'); opts[k]=process.argv[i+1]; }
    if(Object.keys(opts).length!==3) throw new Error('Expected --app --archive --output');
    console.log(JSON.stringify(await buildDeb(opts),null,2));
  } catch(e) { console.error(e.message); process.exitCode=1; }
}
