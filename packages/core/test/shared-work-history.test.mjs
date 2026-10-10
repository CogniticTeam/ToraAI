import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {sessionHistoryKind,sessionForView,sessionModelSource} from '../src/session-mode.js';

test('legacy/code and ToChat work share a kind while ordinary chat stays separate',()=>{
 assert.equal(sessionHistoryKind({}),'work');assert.equal(sessionHistoryKind({application_mode:'tocode',task_mode:'chat'}),'work');assert.equal(sessionHistoryKind({application_mode:'tochat',task_mode:'work'}),'work');assert.equal(sessionHistoryKind({application_mode:'tochat'}),'chat');
 const session={id:'same-id',config:{application_mode:'tocode',cwd:'/project',chat_model_config:{credential_id:'personal'},model_source:'official'}};
 const view=sessionForView(session,'tochat');assert.equal(view.id,session.id);assert.equal(view.config.cwd,'/project');assert.equal(view.config.task_mode,'work');assert.equal(view.config.model_source,'custom');assert.equal(session.config.application_mode,'tocode');
 assert.equal(sessionModelSource({application_mode:'tochat',chat_model_config:{credential_id:'tora-official'}}),'official');assert.throws(()=>sessionForView({config:{application_mode:'tochat',task_mode:'chat'}},'tocode'),/聊天对话/);
});

const home=mkdtempSync(join(tmpdir(),'tora-shared-work-'));process.env.TORA_HOME=home;
const{startASAPIServer}=await import('../src/asapi/server.js');const{loadSessionRecord}=await import('../src/asapi/store.js');const{isRunning}=await import('../src/asapi/bridge.js');
const original=globalThis.fetch,server=await startASAPIServer({port:0}),base='http://127.0.0.1:'+server.address().port;
after(async()=>{globalThis.fetch=original;server.closeAllConnections?.();await new Promise(r=>server.close(r));rmSync(home,{recursive:true,force:true});});
const post=(path,body)=>original(base+path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
test('same work session accepts both execution views, retains messages/cwd, and chat cannot start a Code run',async()=>{
 const agent=(await(await original(base+'/agent/')).json()).agents[0],cwd=join(home,'project');mkdirSync(cwd);
 await post('/admin/tochat-config',{baseURL:'https://shared-fixture.invalid',authToken:'synthetic-account'});
 const mc={credential_id:'tora-official',model:'deepseek-flash',parameters:{thinkingEffort:'high'}};
 const work=await(await post('/sessions/',{agent_id:agent.id,application_mode:'tocode',cwd,chat_model_config:mc})).json(),sent=[];
 try{globalThis.fetch=async(url,init)=>{if(String(url).endsWith('/tochat/title'))return Response.json({title:'Shared work'});sent.push({headers:init.headers,body:JSON.parse(init.body)});return new Response('data: '+JSON.stringify({choices:[{delta:{content:'done'},finish_reason:'stop'}],usage:{prompt_tokens:10,completion_tokens:10,total_tokens:20}})+'\n\ndata: [DONE]\n\n',{headers:{'content-type':'text/event-stream'}});};
 for(const view_mode of ['tocode','tochat']){
  const result=await post('/chat/',{agent_id:agent.id,session_id:work.session_id,view_mode,input:{role:'user',content:[{type:'text',text:'Work in '+view_mode}]}});assert.equal(result.status,200);
  for(let n=0;n<200&&isRunning(work.session_id);n++)await new Promise(r=>setTimeout(r,10));assert.equal(isRunning(work.session_id),false);
 }
 assert.deepEqual(sent.map(r=>r.headers['x-tora-feature']),['tocode','work']);assert.ok(sent.every(r=>r.headers['x-tochat-mode']==='work'));
 const record=loadSessionRecord(work.session_id);assert.equal(record.config.application_mode,'tocode');assert.equal(record.config.cwd,cwd);assert.equal(record.display.filter(m=>m.role==='user').length,2);
 const chat=await(await post('/sessions/',{agent_id:agent.id,application_mode:'tochat',task_mode:'chat',chat_model_config:mc})).json();
 assert.equal((await post('/chat/',{agent_id:agent.id,session_id:chat.session_id,view_mode:'tocode',input:{role:'user',content:[{type:'text',text:'not permitted'}]}})).status,409);assert.equal(loadSessionRecord(chat.session_id).display.length,0);assert.equal(sent.length,2);
 }finally{globalThis.fetch=original;}
});
