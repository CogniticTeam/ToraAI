import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,existsSync,mkdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
const home=mkdtempSync(join(tmpdir(),'tora-live-permission-'));
process.env.TORA_HOME=home;process.env.TORA_BASE_URL='http://live-permission.invalid/v1';process.env.TORA_API_KEY='fixture';process.env.TORA_MODEL='fixture';
const {startASAPIServer}=await import('../src/asapi/server.js');
const {loadSessionRecord,saveSessionRecord}=await import('../src/asapi/store.js');
const {isRunning,interrupt,isAwaitingConfirm,subscribe}=await import('../src/asapi/bridge.js');
const {saveConfig}=await import('../src/config.js');
saveConfig({hooksEnabled:false,checkpointEnabled:false,injectProjectContext:false,repoMapInject:false,permissionRules:[]});
const realFetch=globalThis.fetch,server=await startASAPIServer({port:0}),base='http://127.0.0.1:'+server.address().port;
let model;
globalThis.fetch=(url,options)=>String(url).startsWith('http://live-permission.invalid')?model(JSON.parse(options.body)):realFetch(url,options);
const json=async(path,method='GET',body)=>{const response=await realFetch(base+path,{method,headers:{'content-type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});return {status:response.status,value:await response.json()};};
const agent=(await json('/agent/')).value.agents[0].id;
const wait=async predicate=>{const deadline=Date.now()+6000;while(!predicate()){if(Date.now()>deadline)throw Error('Timed out waiting for fixture');await new Promise(resolve=>setTimeout(resolve,10));}};
const tools=items=>new Response('data: '+JSON.stringify({choices:[{delta:{tool_calls:items.map(([id,name,args],index)=>({index,id,function:{name,arguments:JSON.stringify(args)}}))},finish_reason:'tool_calls'}]})+'\n\ndata: [DONE]\n\n',{headers:{'content-type':'text/event-stream'}});
const done=()=>new Response('data: '+JSON.stringify({choices:[{delta:{content:'fixture done'},finish_reason:'stop'}]})+'\n\ndata: [DONE]\n\n',{headers:{'content-type':'text/event-stream'}});
async function create(mode='default'){
 const id=(await json('/sessions/','POST',{agent_id:agent})).value.session_id,cwd=join(home,id);mkdirSync(cwd);
 const record=loadSessionRecord(id);record.config.name='fixture';record.config.naming={auto:false};record.config.cwd=cwd;record.state.permission_mode=mode;saveSessionRecord(record);return {id,cwd};
}
async function start(id){assert.equal((await json('/chat/','POST',{agent_id:agent,session_id:id,input:{content:[{type:'text',text:'fixture task'}]}})).status,200);await wait(()=>isRunning(id));}
after(async()=>{globalThis.fetch=realFetch;for(const id of running)interrupt(id);server.closeAllConnections?.();await new Promise(resolve=>server.close(resolve));rmSync(home,{recursive:true,force:true});});
const running=[];

test('运行中只允许有效权限 PATCH；待审批写入与后续同轮工具立即使用新模式并持久化',async()=>{
 const {id,cwd}=await create();running.push(id);let round=0;
 const events=[];const unsubscribe=subscribe(id,frame=>events.push(frame.event));
 model=()=>++round===1?tools([['a','Write',{path:'a.txt',content:'A'}],['b','Write',{path:'b.txt',content:'B'}]]):done();
 await start(id);await wait(()=>isAwaitingConfirm(id));
 assert.equal((await json('/sessions/'+id,'PATCH',{permission_mode:'bypass',cwd:home})).status,409);
 assert.equal((await json('/sessions/'+id,'PATCH',{permission_mode:'invalid'})).status,400);
 assert.equal(existsSync(join(cwd,'a.txt')),false);
 assert.equal((await json('/sessions/'+id,'PATCH',{permission_mode:'accept_edits'})).status,200);
 await wait(()=>!isRunning(id));
 assert.equal(existsSync(join(cwd,'a.txt')),true);assert.equal(existsSync(join(cwd,'b.txt')),true);
 const record=loadSessionRecord(id);assert.equal(record.state.permission_mode,'accept_edits');assert.equal(record.state.permission_context.mode,'accept_edits');
 assert.equal(record.display.at(-1).finished_reason,'completed');
 assert.ok(events.some(event=>event.type==='USER_CONFIRM_RESULT'&&event.confirm_results?.[0]?.confirmed), '自动恢复后通过 SSE 清除旧确认卡片');
 unsubscribe();
});

test('模型处理中收紧模式生效；待审批切为只读后拒绝执行，旧的完全访问快照不能覆盖',async()=>{
 const {id,cwd}=await create('bypass');running.push(id);let release;let entered=false;let round=0;
 model=()=>++round===1?new Promise(resolve=>{entered=true;release=()=>resolve(tools([['restricted','Write',{path:'denied.txt',content:'no'}]]));}):done();
 await start(id);await wait(()=>entered);
 assert.equal((await json('/sessions/'+id,'PATCH',{permission_mode:'default'})).status,200);release();
 await wait(()=>isAwaitingConfirm(id));
 assert.equal((await json('/sessions/'+id,'PATCH',{permission_mode:'explore'})).status,200);
 await wait(()=>!isRunning(id));assert.equal(existsSync(join(cwd,'denied.txt')),false);
 assert.equal(loadSessionRecord(id).state.permission_mode,'explore');
});

test('切换完全访问仍保留首次电脑控制确认，不调用真实电脑工具',async()=>{
 const {id}=await create();running.push(id);let round=0;
 model=()=>++round===1?tools([['computer','Computer',{action:'screenshot'}]]):done();
 await start(id);await wait(()=>isAwaitingConfirm(id));
 assert.equal((await json('/sessions/'+id,'PATCH',{permission_mode:'bypass'})).status,200);
 await wait(()=>isAwaitingConfirm(id));assert.equal(loadSessionRecord(id).state.computer_confirmed,undefined);
 interrupt(id);await wait(()=>!isRunning(id));
});


test('运行中切换完全访问不会绕过显式拒绝规则',async()=>{
 saveConfig({permissionRules:[{tool_name:'Write',rule_content:'**',behavior:'deny'}]});
 const {id,cwd}=await create();running.push(id);let release;let entered=false;let round=0;
 model=()=>++round===1?new Promise(resolve=>{entered=true;release=()=>resolve(tools([['blocked','Write',{path:'blocked.txt',content:'no'}]]));}):done();
 await start(id);await wait(()=>entered);
 assert.equal((await json('/sessions/'+id,'PATCH',{permission_mode:'bypass'})).status,200);release();
 await wait(()=>!isRunning(id));assert.equal(existsSync(join(cwd,'blocked.txt')),false);
 saveConfig({permissionRules:[]});
});


test('队长运行中收紧模式同步到等待确认的子代理，不执行原来的命令并清除旧卡片',async()=>{
 const {id,cwd}=await create('bypass');running.push(id);let parentRound=0,workerRound=0;
 const events=[];const unsubscribe=subscribe(id,frame=>events.push(frame.event));
 model=body=>{
  const worker=body.messages.some(message=>typeof message.content==='string'&&message.content.includes('【队长 任务指派】'));
  if(worker)return ++workerRound===1?tools([['child-command','Bash',{command:'touch worker-denied.txt'}]]):done();
  parentRound++;
  if(parentRound===1)return tools([['team','TeamCreate',{name:'fixture team'}]]);
  if(parentRound===2)return tools([['child','AgentCreate',{role:'fixture worker',goal:'fixture',agentCreatePermissions:'accept_edits',isolation:'shared'}]]);
  if(parentRound===3){const text=body.messages.find(message=>message.role==='tool'&&String(message.content).includes('agent_id:'))?.content;const workerId=String(text).match(/agent_id:\s*([A-Za-z0-9_-]+)/)?.[1];assert.ok(workerId);return tools([['run-child','AgentRun',{agent_id:workerId,task:'fixture child'}]]);}
  return done();
 };
 await start(id);await wait(()=>events.some(event=>event.name==='subagent_require_user_confirm'));
 assert.equal((await json('/sessions/'+id,'PATCH',{permission_mode:'explore'})).status,200);
 await wait(()=>!isRunning(id));assert.equal(existsSync(join(cwd,'worker-denied.txt')),false);
 assert.ok(events.some(event=>event.name==='subagent_user_confirm_result'));
 assert.equal(workerRound,2,'子代理应完成拒绝并继续收尾');unsubscribe();
});
