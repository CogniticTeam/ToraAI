import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {EventEmitter} from 'node:events';
import vm from 'node:vm';
import {createReleaseNotesService,releasePage,releaseVersion,updaterNotes} from '../packages/desktop/release-notes.js';
const json=data=>({ok:true,status:200,json:async()=>data});
const tick=async()=>{for(let i=0;i<8;i++)await Promise.resolve();};
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};

test('发行说明按准确版本获取、并发去重，升级后离线展示且确认后不再重复',async()=>{
 let stored={},calls=[];const response=deferred();
 const options={currentVersion:()=> '1.0.3',readState:()=>structuredClone(stored),writeState:value=>{stored=structuredClone(value);},fetchRelease:async url=>{calls.push(url);return response.promise;}};
 const service=createReleaseNotesService(options);
 const first=service.get('1.0.4'),second=service.get('v1.0.4');
 response.resolve(json({tag_name:'v1.0.4',name:'Tora 1.0.4',body:'## Changes\n- Fix navigation.'}));
 assert.equal((await first).notes,'## Changes\n- Fix navigation.');assert.deepEqual(await second,await first);
 assert.equal(calls.length,1);assert.ok(calls[0].endsWith('/tags/v1.0.4'));assert.ok(!calls[0].includes('/latest'));
 assert.equal(service.acknowledge('1.0.4'),false);assert.equal(service.acknowledge('1.0.3'),true);
 const upgraded=createReleaseNotesService({...options,currentVersion:()=> '1.0.4',fetchRelease:()=>{throw Error('Offline');}});
 assert.equal((await upgraded.installed()).version,'1.0.4');
 assert.equal(upgraded.acknowledge('1.0.4'),true);assert.equal(await upgraded.installed(),null);
 const restarted=createReleaseNotesService({...options,currentVersion:()=> '1.0.4'});
 assert.equal(await restarted.installed(),null);
});

test('缺失说明、网络失败和错误版本都不会假冒其他版本或阻断更新',async()=>{
 const options={currentVersion:()=> '1.0.4'};
 const empty=createReleaseNotesService({...options,fetchRelease:async()=>json({tag_name:'v1.0.4',body:null})});
 assert.equal((await empty.get('1.0.4')).status,'empty');
 let attempts=0,fallbackStore={};
 const failed=createReleaseNotesService({...options,readState:()=>structuredClone(fallbackStore),writeState:value=>{fallbackStore=structuredClone(value);},fetchRelease:async()=>{attempts++;throw Error('Offline');}});
 assert.equal(await failed.installed(),null);
 assert.equal((await failed.get('1.0.4')).status,'error');assert.equal(attempts,2,'失败可重试');
 const fallback=await failed.get('1.0.4',{releaseNotes:[{version:'1.0.5',note:'Wrong version'},{version:'1.0.4',note:'<ul><li>Correct update</li></ul><script>unsafe()</script>'}]});
 assert.equal(fallback.status,'ready');assert.ok(fallback.notes.includes('Correct update'));assert.ok(!fallback.notes.includes('unsafe'));
 const offlineRestart=createReleaseNotesService({...options,readState:()=>structuredClone(fallbackStore),fetchRelease(){throw Error('Still offline');}});
 assert.equal((await offlineRestart.installed()).notes,fallback.notes,'GitHub 更新源的备用说明也可在升级后离线显示');
 const wrong=createReleaseNotesService({...options,fetchRelease:async()=>json({tag_name:'v2.0.0',body:'Wrong notes'})});
 assert.equal((await wrong.get('1.0.4')).status,'error');assert.equal(await wrong.installed(),null);
 assert.equal(await wrong.get('../latest'),null);
 assert.equal(updaterNotes({version:'1.0.4',releaseNotes:[{version:'2.0.0',note:'Wrong'}]}),'');
});

test('本机版本的迟到响应不会抹掉新版本的离线发行说明',async()=>{
 let stored={};const tasks=new Map();
 const service=createReleaseNotesService({currentVersion:()=> '1.0.3',writeState:value=>{stored=structuredClone(value);},fetchRelease:url=>{
  const version=url.split('/').at(-1).replace(/^v/,'');const task=deferred();tasks.set(version,task);return task.promise;
 }});
 const old=service.get('1.0.3'),update=service.get('1.0.4');
 tasks.get('1.0.4').resolve(json({tag_name:'v1.0.4',body:'New notes'}));await update;
 tasks.get('1.0.3').resolve(json({tag_name:'v1.0.3',body:'Installed notes'}));await old;
 assert.deepEqual(Object.keys(stored.releases).sort(),['1.0.3','1.0.4']);
 const upgraded=createReleaseNotesService({currentVersion:()=> '1.0.4',readState:()=>stored,fetchRelease(){throw Error('Offline');}});
 assert.equal((await upgraded.installed()).notes,'New notes');
});

test('下载通知立即缓存 GitHub 更新源说明，重启早于 REST 完成时仍能离线显示',async()=>{
 let stored={};const request=deferred();
 const service=createReleaseNotesService({currentVersion:()=> '1.0.3',writeState:value=>{stored=structuredClone(value);},fetchRelease:()=>request.promise});
 assert.ok(service.prime({version:'1.0.4',releaseNotes:'<p>Published changes</p>'}).notes.includes('Published changes'));
 const reading=service.get('1.0.4',{}, {refresh:true});
 const upgraded=createReleaseNotesService({currentVersion:()=> '1.0.4',readState:()=>stored,fetchRelease(){throw Error('Offline after restart');}});
 assert.ok((await upgraded.installed()).notes.includes('Published changes'));
 request.resolve(json({tag_name:'v1.0.4',body:'# Full published notes'}));
 assert.equal((await reading).notes,'# Full published notes');
});

test('无 v 前缀的标签保留正确原文链接；缓存写入失败不影响说明与升级',async()=>{
 const calls=[];const service=createReleaseNotesService({currentVersion:()=> '1.0.4',writeState(){throw Error('Read-only');},fetchRelease:async url=>{
  calls.push(url);return url.endsWith('/v1.0.4')?{ok:false,status:404}:json({tag_name:'1.0.4',body:'Notes'});
 }});
 assert.equal((await service.get('1.0.4')).url,releasePage('1.0.4','1.0.4'));assert.equal(calls.length,2);
 assert.equal(service.acknowledge('1.0.4'),true);assert.equal(await service.installed(),null);
});

test('更新进度独立于说明加载，旧请求不覆盖新版本，下载完成不重复读取',async()=>{
 const source=readFileSync(new URL('../packages/desktop/main.js',import.meta.url),'utf8');
 const load=source.slice(source.indexOf('function loadRequiredReleaseNotes('),source.indexOf('\nfunction observeUpdateDownload('));
 const setup=source.slice(source.indexOf('function setupUpdater('),source.indexOf('\nasync function checkDesktopForUpdate('));
 const tasks=new Map(),calls=[],updater=new EventEmitter();
 const context={app:{isPackaged:true},process:{platform:'darwin'},autoUpdater:updater,updaterReady:false,requiredUpdate:null,console,releaseVersion,releasePage,
  releaseNotesService:{get(version){calls.push(version);const task=deferred();tasks.set(version,task);return task.promise;}},
  publishRequiredUpdate(patch){context.requiredUpdate={...context.requiredUpdate,...patch};}};
 vm.runInNewContext(load+'\n'+setup+'\nsetupUpdater();',context);
 updater.emit('update-available',{version:'1.0.4'});updater.emit('download-progress',{percent:45});
 assert.equal(context.requiredUpdate.percent,45);assert.equal(context.requiredUpdate.status,'downloading');
 updater.emit('update-available',{version:'1.0.5'});
 tasks.get('1.0.4').resolve({version:'1.0.4',notes:'Old'});await tick();
 assert.equal(context.requiredUpdate.releaseNotes.version,'1.0.5');assert.equal(context.requiredUpdate.releaseNotes.status,'loading');
 updater.emit('update-downloaded',{version:'1.0.5'});assert.equal(calls.length,2);
 tasks.get('1.0.5').resolve({version:'1.0.5',notes:'Current',status:'ready'});await tick();
 assert.equal(context.requiredUpdate.status,'ready');assert.equal(context.requiredUpdate.percent,100);assert.equal(context.requiredUpdate.releaseNotes.notes,'Current');
});
