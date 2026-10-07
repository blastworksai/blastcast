// ClaudeBWAI — einh 5 Oct: Mac App Store flavour; the purchase is the licence.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const {isMas,createMasLicenseStore,helperPath}=require('../desktop/mas-flavour.cjs');
const {createLicenseStore}=require('../desktop/license-store.cjs');
test('isMas is strictly true only for mas === true',()=>{
 assert.equal(isMas({mas:true}),true);
 for(const mas of [false,undefined,'true',1,null])assert.equal(isMas({mas}),false);
 assert.equal(isMas({}),false);
});
test('store has exactly the real store methods, with matching sync/async kinds',()=>{
 const real=createLicenseStore({directory:'/nonexistent-blastcast-test'});const mas=createMasLicenseStore();
 assert.deepEqual(Object.keys(mas).sort(),Object.keys(real).sort());
 for(const k of ['load','activate','deactivate'])assert.ok(mas[k]() instanceof Promise,k);
 for(const k of ['status','active'])assert.ok(!(mas[k]() instanceof Promise),k);
});
test('status and active report an App Store licence',async()=>{
 const s=createMasLicenseStore();
 assert.equal(s.active(),true);
 assert.deepEqual(s.status(),{active:true,license:{kind:'app-store'}});
 assert.deepEqual(await s.load(),s.status());
});
test('activate and deactivate say no key is needed',async()=>{
 const s=createMasLicenseStore();const want={active:true,message:'BlastCast from the App Store needs no key.'};
 assert.deepEqual(await s.activate('anything'),want);
 assert.deepEqual(await s.deactivate(),want);
});
test('the module never requires fs',async()=>{
 const src=await readFile(new URL('../desktop/mas-flavour.cjs',import.meta.url),'utf8');
 assert.doesNotMatch(src,/require\(\s*['"](node:)?fs(\/promises)?['"]\s*\)/);
});
test('helperPath maps Resources to Helpers/ssh',()=>{
 assert.equal(helperPath({resourcesPath:'/Applications/BlastCast.app/Contents/Resources'}),'/Applications/BlastCast.app/Contents/Helpers/ssh');
 for(const arg of [{},{resourcesPath:'Contents/Resources'},{resourcesPath:''},undefined])assert.throws(()=>helperPath(arg),/absolute/);
});
