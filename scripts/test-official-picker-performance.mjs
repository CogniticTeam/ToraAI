// CI-only performance probe: synthetic conversations, accounts and responses.
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {chromium} from 'playwright-core';
const home=mkdtempSync(join(tmpdir(),'tora-picker-perf-'));process.env.TORA_HOME=home;
const {startASAPIServer}=await import('../packages/core/src/asapi/server.js');
const {loadSessionRecord,saveSessionRecord}=await import('../packages/core/src/asapi/store.js');
const {userMsg}=await import('../packages/core/src/asapi/protocol.js');
const modelIds=['deepseek-flash','doubao-seed-2-1-lite-260915','gemini-3.8-flash','gpt-6.1-sol','gpt-6-sol','gpt-6-luna','gpt-6-astra','claude-opus-5'];
const cloud=createServer((req,res)=>{const path=new URL(req.url,'http://fixture').pathname;let data={};if(path==='/auth/me')data={id:'picker-perf',username:'picker-perf'};if(path==='/tochat/quota')data={enabled:true,models:modelIds.map(id=>({id,enabled:true})),chatUnlimited:true,canUseAgent:false,remainingPercent:0,subscription:null,windows:[]};if(path==='/models')data={models:[]};if(path==='/polls/config')data={enabled:false};if(path==='/account/messages')data={messages:[],unread:0};res.writeHead(200,{'content-type':'application/json','access-control-allow-origin':'*','access-control-allow-headers':'authorization,content-type'});res.end(JSON.stringify(data));});
await new Promise(resolve=>cloud.listen(0,'127.0.0.1',resolve));const cloudBase='http://127.0.0.1:'+cloud.address().port;
const core=await startASAPIServer({port:0}),base='http://127.0.0.1:'+core.address().port;
const agent=(await(await fetch(base+'/agent/')).json()).agents[0];
const session=await(await fetch(base+'/sessions/',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({agent_id:agent.id,application_mode:'tochat',task_mode:'chat',model_source:'official',chat_model_config:{credential_id:'tora-official',model:'deepseek-flash',parameters:{thinkingEffort:'high'}}})})).json();
const record=loadSessionRecord(session.session_id);record.display=Array.from({length:200},(_,index)=>userMsg(`Benchmark message ${index}: synthetic conversation for model picker profiling.`));saveSessionRecord(record);
const browser=await chromium.launch({headless:true,executablePath:process.env.TORA_CHROME_PATH||'/usr/bin/google-chrome',args:['--no-sandbox']});
try{
 const context=await browser.newContext({viewport:{width:1280,height:800},locale:'zh-CN',colorScheme:'dark'});
 await context.addInitScript(({base,cloudBase})=>{for(const [key,value]of Object.entries({server_url:base,tora_auth_token:'picker-perf-token',tora_auth_username:'picker-perf',tora_auth_api:cloudBase,tora_language_preference:'zh','tora:first-run:intro:v1':'1','tora:first-run:tour:v1':'1','tora:first-use-consent:v1':JSON.stringify({terms:true,privacy:true,crossBorder:true})}))localStorage.setItem(key,value);window.toraWindow={isMaximized:()=>false,onMaximizeChange:()=>{},getSystemLocale:()=> 'zh-CN',getRequiredUpdate:()=>null,onRequiredUpdate:()=>()=>{},reportLanguage:()=>{},reportTheme:()=>{}};},{base,cloudBase});
 const page=await context.newPage(),cdp=await context.newCDPSession(page);await cdp.send('Accessibility.enable');const requests=[];page.on('request',request=>{if(request.resourceType()==='fetch')requests.push(request.url());});
 await page.goto(base+`/tochat/${agent.id}/${session.session_id}?task=chat`);await page.getByText('Benchmark message 199: synthetic conversation for model picker profiling.',{exact:true}).waitFor();const trigger=page.getByRole('button',{name:'选择模型',exact:true});await trigger.waitFor();
 await page.evaluate(()=>document.fonts.ready);await cdp.send('Emulation.setCPUThrottlingRate',{rate:4});
 const results=[];
 for(const variant of ['original','original','no-motion','no-motion']){
  if(variant==='no-motion')await page.addStyleTag({content:'[data-slot="dropdown-menu-content"]{animation:none!important;transition:none!important;transform:none!important;}'});
  const fetchBefore=requests.length;
  await page.evaluate(()=>{
   const state={start:0,visible:null,settled:null,lastFrame:0,maxFrameGap:0,frames:0,longTasks:[],rootAttributeChanges:0,style:null,done:false};window.pickerProbe=state;
   const longObserver=new PerformanceObserver(list=>{for(const entry of list.getEntries())if(state.start&&entry.startTime>=state.start)state.longTasks.push({start:entry.startTime-state.start,duration:entry.duration});});longObserver.observe({type:'longtask',buffered:false});
   const app=document.querySelector('#root');const mutations=new MutationObserver(list=>{if(state.start)state.rootAttributeChanges+=list.length;});mutations.observe(app,{attributes:true,attributeFilter:['aria-hidden','inert']});
   document.addEventListener('pointerdown',()=>{state.start=performance.now();const frame=now=>{if(state.lastFrame)state.maxFrameGap=Math.max(state.maxFrameGap,now-state.lastFrame);state.lastFrame=now;state.frames++;const menu=document.querySelector('[data-slot="dropdown-menu-content"]');if(menu){const style=getComputedStyle(menu);const positioned=menu.parentElement.style.transform!=='translate(0px, -200%)';if(positioned&&style.visibility!=='hidden'&&Number(style.opacity)>0){state.visible??=performance.now()-state.start;state.style??={animation:style.animationName,duration:style.animationDuration,transition:style.transitionProperty};if(Number(style.opacity)===1&&menu.getAnimations().every(animation=>animation.playState!=='running'))state.settled??=performance.now()-state.start;}}if(performance.now()-state.start<650)requestAnimationFrame(frame);else{state.done=true;longObserver.disconnect();mutations.disconnect();}};requestAnimationFrame(frame);},{capture:true,once:true});
  });
  await trigger.click();await page.waitForFunction(()=>window.pickerProbe?.done);const metrics=await page.evaluate(()=>({variant:null,...window.pickerProbe,domNodes:document.querySelectorAll('*').length,hiddenChat:document.querySelector('#root')?.getAttribute('aria-hidden'),scrollLock:document.body.getAttribute('data-scroll-locked')}));delete metrics.start;delete metrics.lastFrame;results.push({...metrics,variant,fetches:requests.length-fetchBefore});
  await page.keyboard.press('Escape');await page.getByRole('menu').waitFor({state:'hidden'});
 }
 await cdp.send('Emulation.setCPUThrottlingRate',{rate:1});writeFileSync('/tmp/tora-official-picker-performance.json',JSON.stringify(results,null,2));console.log('PICKER_PERFORMANCE',JSON.stringify(results));
 assert.ok(results.every(row=>row.visible!==null),'Every popup must be visible');
 await context.close();
}finally{await browser.close();core.closeAllConnections?.();cloud.closeAllConnections?.();await Promise.all([new Promise(resolve=>core.close(resolve)),new Promise(resolve=>cloud.close(resolve))]);rmSync(home,{recursive:true,force:true});}
