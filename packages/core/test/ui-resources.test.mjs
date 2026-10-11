import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
const home=mkdtempSync(join(tmpdir(),'tora-ui-resources-'));process.env.TORA_HOME=home;
const {startASAPIServer,acquireUIUpdateLock}=await import('../src/asapi/server.js');
test('versioned assets, SPA entry, old bundled assets, no-cache HTML and mutation lock',async t=>{
 const root=join(home,'ui');mkdirSync(join(root,'assets'),{recursive:true});writeFileSync(join(root,'index.html'),'<html>NEW_UI</html>');writeFileSync(join(root,'assets/app.js'),'signed-ui');
 const srv=await startASAPIServer({port:0,uiResources:()=>({activeDirectory:root,versions:new Map([['ui-1',root]])})});t.after(async()=>{srv.closeAllConnections();await new Promise(r=>srv.close(r));rmSync(home,{recursive:true,force:true});});const base=`http://127.0.0.1:${srv.address().port}`;
 const page=await fetch(base+'/chat',{headers:{accept:'text/html'}});assert.equal(await page.text(),'<html>NEW_UI</html>');assert.equal(page.headers.get('cache-control'),'no-store');
 const asset=await fetch(base+'/ui/ui-1/assets/app.js');assert.equal(await asset.text(),'signed-ui');assert.match(asset.headers.get('cache-control'),/immutable/);
 assert.equal((await fetch(base+'/ui/ui-unknown/assets/app.js')).status,404);assert.equal((await fetch(base+'/ui/ui-1/assets/missing.js')).status,404);assert.equal((await fetch(base+'/ui/ui-1/release.json')).status,403);
 assert.equal((await fetch(base+'/ui/ui-1/assets/%2e%2e%2findex.html')).status,403);
 const html=readFileSync(new URL('../../desktop/frontend/dist/index.html',import.meta.url),'utf8'),path=html.match(/src="(\/assets\/[^"]+\.js)"/)?.[1];if(path){const old=await fetch(base+path);assert.equal(old.status,200);assert.ok((await old.text()).length>100);}
 const {createSchedule,deleteSchedule,evaluateSchedules,setScheduleFireHandler}=await import('../src/asapi/schedules.js');let fires=0;
 const schedule=createSchedule({agent_id:'fixture',cron_expression:'12 3 * * *',timezone:'UTC',enabled:true});setScheduleFireHandler(()=>{fires++;return 'fixture-session';});
 const release=acquireUIUpdateLock();assert.equal(typeof release,'function');assert.equal(acquireUIUpdateLock(),null);
 assert.deepEqual(await evaluateSchedules(new Date('2026-10-11T03:12:40Z')),[]);assert.equal(fires,0);
 assert.equal((await fetch(base+'/health')).status,200);assert.equal((await fetch(base+'/admin/config',{method:'POST',body:'{}'})).status,403);release();await evaluateSchedules(new Date('2026-10-11T03:13:05Z'));assert.equal(fires,1);deleteSchedule(schedule.id);
 assert.notEqual((await fetch(base+'/admin/config',{method:'POST',body:'{}'})).status,403);
 const bootstrapLock=acquireUIUpdateLock();assert.equal((await fetch(base+'/admin/tochat-config',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({baseURL:'https://fixture.invalid',authToken:'synthetic-session'})})).status,200);assert.equal((await fetch(base+'/admin/tochat-config',{method:'POST',headers:{origin:'https://foreign.invalid'},body:'{}'})).status,403);bootstrapLock();
 const{setAccessBlock,accessBlockReason}=await import('../src/asapi/access.js');setAccessBlock('account','fixture account restriction');const accountLocked=acquireUIUpdateLock();assert.equal(typeof accountLocked,'function');assert.equal((await fetch(base+'/admin/tochat-config',{method:'POST',body:'{}'})).status,403);accountLocked();assert.equal(accessBlockReason(),'fixture account restriction');setAccessBlock('account','');
});
