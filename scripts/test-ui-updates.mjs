import {test} from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync,sign} from 'node:crypto';
import {mkdtemp,writeFile,readFile,mkdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {gzipSync} from 'node:zlib';
import {createUIUpdater,digest,readManifest,assetPath} from '../packages/desktop/ui-updates.js';
import {createUIUpdateController} from '../packages/desktop/ui-update-controller.js';
const pair=generateKeyPairSync('ed25519'),feed='https://updates.fixture.invalid/stable.json';
function release(build=2,options={}){
 const version=`ui-${build}`,files=[{path:'index.html',data:Buffer.from(`<meta name="tora-ui-version" content="${version}"><script src="/ui/${version}/assets/app.js"></script>`)},{path:'assets/app.js',data:Buffer.from('window.fixture=true;')}];
 const data=gzipSync(JSON.stringify({files:files.map(f=>({path:f.path,data:f.data.toString('base64')}))}));
 const manifest={protocol:1,version,build,minimumShell:'1.1.0',url:feed.replace('stable.json',`${version}.json.gz`),bytes:data.length,sha256:digest(data),files:files.map(f=>({path:f.path,bytes:f.data.length,sha256:digest(f.data)})),...options};
 const payload=Buffer.from(JSON.stringify(manifest));return {data,manifest,envelope:{payload:payload.toString('base64'),signature:sign(null,payload,pair.privateKey).toString('base64')}};
}
async function fixture(t){
 const root=await mkdtemp(join(tmpdir(),'tora-hot-ui-')),bundled=join(root,'bundled');await mkdir(bundled);await writeFile(join(bundled,'index.html'),'bundled');
 t.after(()=>rm(root,{recursive:true,force:true}));let current=release(),offline=false,calls=0;
 const options={directory:join(root,'updates'),publicKey:pair.publicKey,shellVersion:'1.1.0',bundledDirectory:bundled,bundledBuild:1,feed,fetcher:async url=>{calls++;if(offline)throw Error('offline');return url===feed?Response.json(current.envelope):new Response(current.data);}};
 const updater=createUIUpdater(options);await updater.initialize();return {root,bundled,updater,options,set:value=>current=value,offline:()=>offline=true,calls:()=>calls};
}
test('verified release stages, activates, preserves bundled resources and boots offline',async t=>{
 const f=await fixture(t);assert.equal((await f.updater.check()).status,'ready');assert.equal(f.updater.resources().activeDirectory,f.bundled);
 assert.equal(await f.updater.activate(),'ui-2');assert.equal(f.updater.info().trial,true);assert.equal(await f.updater.confirm('ui-999'),false);assert.equal(await f.updater.confirm('ui-2'),true);
 assert.equal(await readFile(join(f.updater.resources().activeDirectory,'assets/app.js'),'utf8'),'window.fixture=true;');
 f.offline();const restarted=createUIUpdater(f.options);await restarted.initialize();assert.equal(restarted.info().active,'ui-2');await assert.rejects(restarted.check(),/offline/);assert.equal(restarted.info().active,'ui-2');
});
test('unconfirmed boot and reported failure roll back, quarantine bad releases and resist replay',async t=>{
 const f=await fixture(t);await f.updater.check();await f.updater.activate();await f.updater.confirm('ui-2');
 f.set(release(3));await f.updater.check();await f.updater.activate();const restarted=createUIUpdater(f.options);await restarted.initialize();assert.equal(restarted.info().active,'ui-2');
 assert.equal((await restarted.check()).staged,null);f.set(release(4));await restarted.check();await restarted.activate();await restarted.rollback();assert.equal(restarted.info().active,'ui-2');
 f.set(release(2));assert.equal((await restarted.check()).staged,null);
});
test('signatures, hashes, compatibility, trusted origins, duplicate paths and size limits fail closed',async t=>{
 const f=await fixture(t);const good=release();
 f.set({...good,envelope:{...good.envelope,signature:Buffer.alloc(64).toString('base64')}});await assert.rejects(f.updater.check(),/signature/);
 f.set({...good,data:Buffer.from('tampered')});await assert.rejects(f.updater.check(),/integrity/);assert.equal(f.updater.info().active,'bundled');
 for(const options of [{minimumShell:'2.0.0'},{protocol:2},{url:'https://foreign.invalid/pkg'},{url:'http://updates.fixture.invalid/pkg'},{bytes:81*1024*1024},{files:[...good.manifest.files,good.manifest.files[0]]},{files:[{path:'../outside',bytes:1,sha256:'0'.repeat(64)}]}])assert.throws(()=>readManifest(release(5,options).envelope,pair.publicKey,'1.1.0',feed));
 for(const path of ['../secret','assets/../../secret','/etc/passwd','a\\b','a//b','C:/tmp','a%2fb','a\0b'])assert.throws(()=>assetPath(path));
});
test('archive entries cannot escape, omit or replace signed assets, and damaged caches use bundled UI',async t=>{
 const f=await fixture(t),r=release();const data=gzipSync(JSON.stringify({files:[{path:'../outside',data:'YWJj'}]}));
 const payload=Buffer.from(JSON.stringify({...r.manifest,bytes:data.length,sha256:digest(data)}));f.set({...r,data,envelope:{payload:payload.toString('base64'),signature:sign(null,payload,pair.privateKey).toString('base64')}});
 await assert.rejects(f.updater.check(),/archive/);assert.equal(f.updater.info().active,'bundled');
 f.set(r);await f.updater.check();await f.updater.activate();await f.updater.confirm('ui-2');await writeFile(join(f.updater.resources().activeDirectory,'assets/app.js'),'corrupted');const restarted=createUIUpdater(f.options);await restarted.initialize();assert.equal(restarted.info().active,'bundled');
});
test('a newer packaged build wins over older cached frontend assets',async t=>{
 const f=await fixture(t);await f.updater.check();await f.updater.activate();await f.updater.confirm('ui-2');const restarted=createUIUpdater({...f.options,bundledBuild:10});await restarted.initialize();assert.equal(restarted.info().active,'bundled');assert.equal((await restarted.check()).staged,null);
});
test('activation requires renderer checkpoint plus core idle lock; boot nonce, timeout and rollback are enforced',async t=>{
 const f=await fixture(t);await f.updater.check();let busy=true,held=false,reloads=0;const messages=[],timers=new Map();let seq=0;
 const win={isDestroyed:()=>false,webContents:{send:(...data)=>messages.push(data),reload:()=>reloads++}};
 const controller=createUIUpdateController({updater:f.updater,getWindow:()=>win,acquireLock:()=>{if(busy)return null;held=true;return()=>{held=false;};},setTimer:fn=>{timers.set(++seq,fn);return seq;},clearTimer:id=>timers.delete(id)});
 assert.equal(controller.request(),true);assert.equal(controller.request(),false);const first=messages.at(-1)[1];assert.equal(await controller.prepared('foreign',true),false);assert.equal(await controller.prepared(first,true),false);assert.equal(f.updater.info().active,'bundled');
 busy=false;controller.request();assert.equal(await controller.prepared(messages.at(-1)[1],false),false);assert.equal(reloads,0);
 controller.request();await controller.prepared(messages.at(-1)[1],true);assert.equal(reloads,1);assert.equal(held,true);assert.equal(await controller.ready('ui-2','foreign'),false);
 await controller.ready('ui-2',controller.state().nonce);assert.equal(held,false);
 f.set(release(3));await f.updater.check();controller.request();await controller.prepared(messages.at(-1)[1],true);assert.equal(held,true);
 const timeout=[...timers.values()][0];timeout();for(let n=0;n<20&&held;n++)await new Promise(resolve=>setTimeout(resolve,1));assert.equal(held,false);assert.equal(f.updater.info().active,'ui-2');
});

test('staged UI can activate on cold startup before a window exists, with the same boot rollback protection',async t=>{
 const f=await fixture(t);await f.updater.check();let held=false;
 const controller=createUIUpdateController({updater:f.updater,getWindow:()=>null,acquireLock:()=>{held=true;return()=>held=false;},setTimer:()=>1,clearTimer(){}});
 assert.equal(await controller.bootstrap(),true);assert.equal(controller.state().active,'ui-2');assert.equal(held,true);
 assert.equal(await controller.ready('ui-2',controller.state().nonce),true);assert.equal(held,false);
});
