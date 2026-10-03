import {test} from 'node:test';
import http from 'node:http';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,symlink,rm,stat,truncate,open} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {parseSessionTranscript,MAX_IMPORT_FILE_BYTES} from '../src/session-import.js';
const at='2026-10-03T00:00:00.000Z',jsonl=rows=>rows.map(row=>JSON.stringify(row)).join('\n');
const codex=()=>jsonl([
 {type:'session_meta',payload:{id:'source-codex',cwd:'/foreign/project',timestamp:at,base_instructions:'DO NOT IMPORT THIS SYSTEM PROMPT'}},
 {type:'event_msg',timestamp:at,payload:{type:'task_started',turn_id:'one'}},
 {type:'response_item',timestamp:at,payload:{type:'message',role:'system',content:[{type:'input_text',text:'secret settings'}]}},
 {type:'response_item',timestamp:at,payload:{type:'message',role:'user',id:'u1',content:[{type:'input_text',text:'first question'}]}},
 {type:'event_msg',timestamp:at,payload:{type:'item_completed',item:{type:'UserMessage',id:'u1',content:[{type:'Text',text:'first question'}]}}},
 {type:'response_item',timestamp:at,payload:{type:'message',role:'assistant',id:'a1',phase:'final_answer',content:[{type:'output_text',text:'first answer'}]}},
 {type:'event_msg',timestamp:at,payload:{type:'item_completed',item:{type:'AgentMessage',id:'a1',phase:'final_answer',content:[{type:'text',text:'first answer'}]}}},
 {type:'response_item',timestamp:at,payload:{type:'function_call',name:'Bash',arguments:'{"command":"never run this"}'}},
]);
test('Codex native/event mirrors import exactly once; system and tool execution records stay out',()=>{
 const result=parseSessionTranscript({content:codex()});assert.equal(result.source,'codex');assert.equal(result.external_id,'source-codex');assert.equal(result.cwd,'/foreign/project');assert.deepEqual(result.messages.map(message=>message.text),['first question','first answer']);assert.ok(!JSON.stringify(result.messages).includes('secret settings'));assert.equal(result.warnings.omitted_process_blocks,1);
 assert.equal(parseSessionTranscript({content:codex()}).fingerprint,result.fingerprint);
});
test('legacy and new Codex turns can coexist; legacy event-only answers survive',()=>{
 const content=jsonl([{type:'session_meta',payload:{id:'mixed',timestamp:at}},
 {type:'turn_context',payload:{turn_id:'old'}},{type:'event_msg',timestamp:at,payload:{type:'user_message',message:'old question'}},{type:'event_msg',timestamp:at,payload:{type:'agent_message',message:'old answer'}},
 {type:'turn_context',payload:{turn_id:'new'}},{type:'event_msg',timestamp:at,payload:{type:'item_completed',item:{type:'UserMessage',id:'new-u',content:[{type:'Text',text:'new question'}]}}},{type:'event_msg',timestamp:at,payload:{type:'item_completed',item:{type:'AgentMessage',id:'new-a',content:[{type:'Text',text:'new answer'}]}}}]);
 assert.deepEqual(parseSessionTranscript({content}).messages.map(message=>message.text),['old question','old answer','new question','new answer']);
});
test('Claude split assistant blocks union without losing later text; growing snapshots replace prefixes',()=>{
 const entry=content=>({type:'assistant',timestamp:at,sessionId:'claude-one',message:{id:'same-assistant',role:'assistant',model:'claude-test',content}});
 const content=jsonl([{type:'custom-title',customTitle:'Imported Claude title'}, {type:'user',uuid:'u',timestamp:at,sessionId:'claude-one',cwd:'/other',message:{role:'user',content:'question'}},
 entry([{type:'thinking',thinking:'private process'}]),entry([{type:'text',text:'A'}]),entry([{type:'text',text:'AB'}]),entry([{type:'text',text:'Second block'}]),entry([{type:'text',text:'Second block'}]),
 {type:'user',timestamp:at,message:{role:'user',content:[{type:'tool_result',content:'not a human input'}]}}, {type:'assistant',isSidechain:true,message:{role:'assistant',content:'subagent note'}},
 {type:'assistant',message:{role:'assistant',model:'<synthetic>',content:'synthetic'}}]);
 const result=parseSessionTranscript({content});assert.equal(result.title,'Imported Claude title');assert.equal(result.model,'claude-test');assert.deepEqual(result.messages.map(message=>message.text),['question','AB\n\nSecond block']);assert.equal(result.warnings.omitted_process_blocks,2);
});
test('malformed tails and missing attachments are visible in warnings; untimestamped fingerprints are stable',()=>{
 const content=jsonl([{type:'user',uuid:'u',message:{role:'user',content:[{type:'text',text:'hello'},{type:'image',source:{data:'omitted'}}]}}])+'\n{unfinished';
 const parsed=parseSessionTranscript({content});assert.equal(parsed.warnings.invalid_lines,1);assert.equal(parsed.warnings.omitted_attachments,1);assert.equal(parsed.warnings.unknown_timestamps,1);assert.equal(parsed.created_at,null);assert.equal(parseSessionTranscript({content}).fingerprint,parsed.fingerprint);
 for(const value of ['null','[]','{"token":"not-a-transcript"}','broken'])assert.throws(()=>parseSessionTranscript({content:value}));
 assert.throws(()=>parseSessionTranscript({content:codex(),source:'claude'}),error=>error.code==='source_mismatch');
});

test('desktop import is additive, deduplicated across concurrent commits, bounded and resumable with plain chat context',async()=>{
 const home=await mkdtemp(join(tmpdir(),'tora-session-import-'));const originalCwd=process.cwd();process.env.TORA_HOME=join(home,'tora');const codexHome=join(home,'codex');process.chdir(home);
 process.env.TORA_BASE_URL='http://import-model.invalid/v1';process.env.TORA_API_KEY='synthetic-import-key';process.env.TORA_MODEL='import-model';
 let server;const originalFetch=globalThis.fetch;let modelMessages;
 try{
  const root=join(codexHome,'sessions');await mkdir(root,{recursive:true});const path=join(root,'rollout.jsonl');const source=codex();await writeFile(path,source);await writeFile(join(codexHome,'session_index.jsonl'),jsonl([{id:'source-codex',thread_name:'Source index title'}]));
  const outside=join(home,'outside.jsonl');await writeFile(outside,source);await symlink(outside,join(root,'linked.jsonl'));
  const store=await import('../src/asapi/store.js');const service=await import('../src/asapi/session-import.js');const {startASAPIServer}=await import('../src/asapi/server.js');
  const agent=store.listAgents()[0];const existing=store.createSessionRecord({agent_id:agent.id,toraCfg:{model:'import-model'}});existing.config.name='Do not overwrite';store.saveSessionRecord(existing);
  const scan=await service.discoverSessionImports('codex',{sourceRoots:[root]});assert.equal(scan.sessions.length,1);assert.equal(scan.sessions[0].title,'Source index title');assert.equal(store.listSessionRecords().length,1);
  const preview=await service.previewSessionImports({selection_ids:[scan.sessions[0].selection_id]});assert.equal(preview.entries[0].message_count,2);assert.equal(preview.entries[0].title,'Source index title');assert.equal(store.listSessionRecords().length,1);
  const request={preview_id:preview.preview_id,entry_ids:[preview.entries[0].id],agent_id:agent.id,application_mode:'tocode'};
  const commits=await Promise.all([service.commitSessionImports(request),service.commitSessionImports(request)]);assert.equal(commits.reduce((sum,result)=>sum+result.imported,0),1);assert.equal(commits.reduce((sum,result)=>sum+result.skipped,0),1);
  const imported=store.loadSessionRecord(commits.find(result=>result.imported).session_ids[0]);assert.equal(imported.config.cwd,null);assert.equal(imported.state.permission_mode,'default');assert.equal(imported.config.name,'Source index title');assert.equal(imported.display.length,2);assert.deepEqual(imported.internal.map(message=>message.role),['user','assistant']);assert.equal(imported.import_info.source_cwd,'/foreign/project');assert.equal(store.loadSessionRecord(existing.id).config.name,'Do not overwrite');assert.equal(await readFile(path,'utf8'),source);
  assert.equal((await service.previewSessionImports({files:[{name:'again.jsonl',content:source}]})).entries[0].duplicate,true);
  const withError=await service.previewSessionImports({files:[{name:'bad.json',content:'null'},{name:'good.jsonl',content:source}]});assert.equal(withError.entries.length,1);assert.equal(withError.errors.length,1);
  await assert.rejects(service.previewSessionImports({selection_ids:['not-an-issued-token']}),error=>error.code==='expired_selection');
  await rm(path);await symlink(outside,path);await assert.rejects(service.previewSessionImports({selection_ids:[scan.sessions[0].selection_id]}),error=>error.code==='invalid_path');
  const huge=join(root,'huge.jsonl');const handle=await open(huge,'w');await handle.truncate(MAX_IMPORT_FILE_BYTES+1);await handle.close();assert.ok((await stat(huge)).size>MAX_IMPORT_FILE_BYTES);
  await assert.rejects(service.readSessionImportBody((async function*(){yield Buffer.alloc(32);})(),16),error=>error.status===413);
  globalThis.fetch=async(url,options)=>{if(String(url).startsWith('http://import-model.invalid')){modelMessages=JSON.parse(options.body).messages;return new Response('data: '+JSON.stringify({choices:[{delta:{content:'continued import conversation'}}]})+'\n\ndata: [DONE]\n\n',{headers:{'content-type':'text/event-stream'}});}return originalFetch(url,options);};
  server=await startASAPIServer({port:0});const base='http://127.0.0.1:'+server.address().port;
  const foreign=await fetch(base+'/sessions/import/sources?source=codex',{headers:{origin:'https://foreign.invalid'}});assert.equal(foreign.status,403);
  const hostileStatus=await new Promise((resolve,reject)=>{const request=http.get(base+'/sessions/import/sources?source=codex',{headers:{host:'foreign.invalid'}},response=>{response.resume();resolve(response.statusCode);});request.on('error',reject);});assert.equal(hostileStatus,403);
  const response=await fetch(base+'/chat/',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({agent_id:agent.id,session_id:imported.id,input:{content:[{type:'text',text:'continue here'}]}})});assert.ok(response.ok,await response.text());
  for(let attempt=0;attempt<100;attempt++){await new Promise(resolve=>setTimeout(resolve,20));if(store.loadSessionRecord(imported.id).display.some(message=>message.content.some(block=>block.text==='continued import conversation')))break;}
  assert.ok(modelMessages.some(message=>message.content==='first question'));assert.ok(modelMessages.some(message=>message.content==='first answer'));
  assert.ok(store.loadSessionRecord(imported.id).display.some(message=>message.content.some(block=>block.text==='continued import conversation')));
 }finally{server?.close();globalThis.fetch=originalFetch;process.chdir(originalCwd);await rm(home,{recursive:true,force:true});}
});
