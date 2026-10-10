import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,symlinkSync,rmSync,realpathSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createServer} from 'node:http';
import {startHtmlPreview,localPreviewUrl,checkPreviewUrl,prepareReplyPreview,openReplyPreview,closePreviewServers} from '../src/web-preview.js';
import {webPreviewTool} from '../src/tools/web-preview.js';
import {buildSystemPrompt} from '../src/prompt.js';

const home=mkdtempSync(join(tmpdir(),'tora-web-preview-'));process.env.TORA_HOME=join(home,'data');
const cwd=join(home,'site');mkdirSync(cwd);writeFileSync(join(cwd,'index.html'),'<html><link rel="stylesheet" href="/style.css"><h1>Website ready</h1></html>');writeFileSync(join(cwd,'style.css'),'h1 { color: red }');writeFileSync(join(cwd,'.env'),'secret');writeFileSync(join(home,'outside.html'),'<h1>outside</h1>');symlinkSync(join(home,'outside.html'),join(cwd,'escape.html'));
const blocks=(path,state='success')=>[{type:'tool_call',id:'write',name:'Write',input:JSON.stringify({path})},{type:'tool_result',id:'write',name:'Write',state}];
const original=globalThis.fetch;
const {startASAPIServer}=await import('../src/asapi/server.js');const{loadSessionRecord}=await import('../src/asapi/store.js');const{isRunning,subscribe}=await import('../src/asapi/bridge.js');
const server=await startASAPIServer({port:0}),base='http://127.0.0.1:'+server.address().port;
after(async()=>{globalThis.fetch=original;await closePreviewServers();server.closeAllConnections?.();await new Promise(done=>server.close(done));rmSync(home,{recursive:true,force:true});});

test('static preview serves web assets on loopback, restricts scope and survives restart through the card',async()=>{
 const [preview,concurrent]=await Promise.all([startHtmlPreview('index.html',{cwd}),startHtmlPreview('index.html',{cwd})]);assert.equal(preview.url,concurrent.url);assert.match(preview.url,/^http:\/\/127\.0\.0\.1:\d+\/index\.html$/);assert.match(await(await original(preview.url)).text(),/Website ready/);
 const origin=new URL(preview.url).origin;assert.equal((await original(origin+'/style.css')).headers.get('content-type'),'text/css; charset=utf-8');
 assert.equal((await original(origin+'/.env')).status,403);assert.equal((await original(origin+'/escape.html')).status,403);assert.equal((await original(origin+'/index.html',{method:'POST'})).status,405);
 await assert.rejects(startHtmlPreview('../outside.html',{cwd}),/越界/);await assert.rejects(startHtmlPreview('escape.html',{cwd}),/越界/);
 const message={metadata:{web_preview:preview},content:blocks('index.html')};await closePreviewServers();const reopened=await openReplyPreview(message,{cwd});assert.match(await(await original(reopened.url)).text(),/Website ready/);
 assert.equal(await prepareReplyPreview(blocks('index.html','error'),{cwd}),null);
 writeFileSync(join(cwd,'source.html'),'<script type="module" src="/src/main.tsx"></script>');await assert.rejects(startHtmlPreview('source.html',{cwd}),/需要构建/);
});

test('framework preview is explicitly registered only after a loopback HTML server responds',async()=>{
 assert.throws(()=>localPreviewUrl('https://example.com'),/本机/);assert.throws(()=>localPreviewUrl('http://user:pass@localhost:3000'),/本机/);
 const app=createServer((req,res)=>{res.setHeader('content-type','text/html');res.end('<h1>Framework</h1>');});await new Promise(done=>app.listen(0,'127.0.0.1',done));
 try {const url='http://127.0.0.1:'+app.address().port+'/';assert.equal(await checkPreviewUrl(url),url);const result=await webPreviewTool.execute({url},{cwd});assert.equal(result.meta.web_preview.kind,'server');assert.equal(result.meta.web_preview.url,url);}
 finally{app.closeAllConnections?.();await new Promise(done=>app.close(done));}
 const prompt=buildSystemPrompt({basePrompt:'fixture',toolNames:['Write','WebPreview']});assert.match(prompt,/网页交付/);assert.doesNotMatch(buildSystemPrompt({basePrompt:'fixture',toolNames:['WebSearch']}),/网页交付/);
});

test('a successful website turn auto-starts preview, emits its card event and persists the same reply artifact',async()=>{
 const agent=(await(await original(base+'/agent/')).json()).agents[0],post=(path,body)=>original(base+path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
 await post('/admin/tochat-config',{baseURL:'https://preview-fixture.invalid',authToken:'synthetic-account'});
 const made=await(await post('/sessions/',{agent_id:agent.id,cwd,permission_mode:'bypass',application_mode:'tocode',chat_model_config:{credential_id:'tora-official',model:'deepseek-flash'}})).json();
 let calls=0;const events=[],unsub=subscribe(made.session_id,frame=>events.push(frame.event));
 try {
  globalThis.fetch=async(url,init)=>{
   if(String(url).endsWith('/tochat/title'))return Response.json({title:'Website'});
   assert.match(String(url),/preview-fixture/);calls++;
   const delta=calls===1?{tool_calls:[{index:0,id:'html-write',type:'function',function:{name:'Write',arguments:JSON.stringify({path:'new-site.html',content:'<html><h1>Generated website</h1></html>'})}}]}:{content:'Created the website.'};
   return new Response('data: '+JSON.stringify({choices:[{delta,finish_reason:calls===1?'tool_calls':'stop'}],usage:{prompt_tokens:10,completion_tokens:10}})+'\n\ndata: [DONE]\n\n',{headers:{'content-type':'text/event-stream'}});
  };
  const run=await post('/chat/',{agent_id:agent.id,session_id:made.session_id,view_mode:'tocode',input:{role:'user',content:[{type:'text',text:'Create a website'}]}});assert.equal(run.status,200);
  for(let n=0;n<300&&isRunning(made.session_id);n++)await new Promise(done=>setTimeout(done,10));assert.equal(isRunning(made.session_id),false);
  const record=loadSessionRecord(made.session_id),reply=record.display.find(message=>message.role==='assistant');assert.equal(reply.finished_reason,'completed');assert.equal(reply.metadata.web_preview.kind,'html');assert.equal(calls,2);
  assert.match(await(await original(reply.metadata.web_preview.url)).text(),/Generated website/);assert.ok(events.some(event=>event.name==='web_preview_ready'&&event.value.reply_id===reply.id));
  const card=await post('/sessions/'+made.session_id+'/preview',{reply_id:reply.id});assert.equal(card.status,200);assert.equal((await card.json()).entry,realpathSync(join(cwd,'new-site.html')));
  assert.equal((await post('/sessions/'+made.session_id+'/preview',{reply_id:'unknown'})).status,404);
 }finally {globalThis.fetch=original;unsub();}
});
