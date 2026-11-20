import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {join} from 'node:path';
import {runInNewContext} from 'node:vm';
import {webcrypto as crypto} from 'node:crypto';

const ts=createRequire(new URL('../../package.json',import.meta.url))('typescript');
const source=name=>readFileSync(new URL(name,import.meta.url),'utf8');
const compile=name=>ts.transpileModule(source(name),{compilerOptions:{module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX,target:ts.ScriptTarget.ES2023}}).outputText;
const storeCode=compile('./authStore.ts');
const flowCode=compile('../components/auth/AuthFlow.tsx');
const accountCode=compile('../components/dialog/AccountSection.tsx');
const requestCode=compile('../lib/authFlow.ts');
const toraService={ authBaseURL:()=> 'https://api.fixture.invalid' };
const mainSource=source('../../../main.js');
const mainAuthBlock=mainSource.slice(mainSource.indexOf('  const AUTH_FILE ='),mainSource.indexOf('\n  // 权限白名单'));
const senderGuard=mainSource.match(/function isMainWindowSender\(event\) \{[\s\S]*?\n\}/)?.[0];
const flush=()=>new Promise(resolve=>setImmediate(resolve));
const deferred=()=>{let resolve;const promise=new Promise(done=>{resolve=done;});return{promise,resolve};};
const profile=(name)=>({token:`fixture-session-${name}`,email:`${name}@fixture.invalid`,username:`user-${name}`});
const operation=(controller=new AbortController(),initialToken=null)=>({id:crypto.randomUUID(),signal:controller.signal,initialToken});

// Evaluate only the real auth block, with an in-memory encrypted-file fixture.
// No Electron process, credentials, model services or filesystem writes are used.
function mainStore(){
 let disk=null,writes=0,disconnects=0,pluginStops=0,hold=null;
 const records=[],handlers=new Map(),listeners=new Map();
 const mainFrame={},webContents={mainFrame},win={webContents};
 const trusted={sender:webContents,senderFrame:mainFrame};
 const safeStorage={isEncryptionAvailable:()=>true,encryptString:value=>Buffer.from('fixture-encrypted:'+value),decryptString:bytes=>{
  const text=bytes.toString();assert.ok(text.startsWith('fixture-encrypted:'));return text.slice('fixture-encrypted:'.length);
 }};
 runInNewContext(senderGuard+'\n'+mainAuthBlock,{
  win,Buffer,join,storageEdition:null,toraService:{origin:toraService.authBaseURL()},app:{getPath:()=>'/fixture-memory-only'},safeStorage,
  existsSync:()=>disk!==null,readFileSync:()=>disk,
  writeFileSync(_path,text){disk=text;writes++;records.push(JSON.parse(text));},
  disconnectCodex(){disconnects++;},setDesktopAccessBlocked(){},
  desktopPlugins:{stopMcp(){pluginStops++;}},
  net:{fetch:async()=>Response.json({})},AbortSignal,
  windowIpc:{on:(name,listener)=>listeners.set(name,listener),handle:(name,handler)=>handlers.set(name,handler)},
 });
 const sync=(name,args,event=trusted)=>{
  const e={...event},replies=[];
  // Electron sends the first assignment immediately. A later assignment cannot replace it.
  Object.defineProperty(e,'returnValue',{set:value=>replies.push(value)});
  const listener=listeners.get(name);assert.ok(listener,name);
  listener(e,...args);
  assert.equal(replies.length,1,`${name} must reply exactly once to its synchronous caller`);
  return replies[0];
 };
 const invoke=(name,args,event=trusted)=>{const handler=handlers.get(name);assert.ok(handler,name);return handler(event,...args);};
 const bridge={
  getToken:()=>sync('auth:get-token',[]),getEmail:()=>sync('auth:get-email',[]),getUsername:()=>sync('auth:get-username',[]),
  setToken:value=>Promise.resolve(invoke('auth:set-token',[value])),setEmail:value=>Promise.resolve(invoke('auth:set-email',[value])),setUsername:value=>Promise.resolve(invoke('auth:set-username',[value])),
  delToken:()=>Promise.resolve(invoke('auth:del-token',[])),delEmail:()=>Promise.resolve(invoke('auth:del-email',[])),delUsername:()=>Promise.resolve(invoke('auth:del-username',[])),
  beginProfileCommit:(id,initialToken)=>sync('auth:begin-profile',[id,initialToken]),
  cancelProfileCommit:(id,fence)=>sync('auth:cancel-profile',[id,fence]),
  async commitProfile(id,fence,value){
   const captured=hold;hold=null;
   if(captured?.phase==='before')await captured.wait.promise;
   const result=invoke('auth:commit-profile',[id,fence,value]);
   if(captured?.phase==='after')await captured.wait.promise;
   return result;
  },
 };
 return{bridge,sync,invoke,trusted,webContents,mainFrame,records,
  get writes(){return writes;},get disk(){return disk;},get disconnects(){return disconnects;},get pluginStops(){return pluginStops;},
  holdNext(phase='before'){const wait=deferred();hold={phase,wait};return wait;},
 };
}
function authStore(bridge){
 const storage=new Map(),events=[];
 const window={...(bridge?{toraAuth:bridge}:{}),dispatchEvent:event=>events.push(event.type)};
 const localStorage={getItem:key=>storage.get(key)??null,setItem:(key,value)=>storage.set(key,String(value)),removeItem:key=>storage.delete(key)};
 const module={exports:{}};
 runInNewContext(storeCode,{module,exports:module.exports,window,localStorage,Event,DOMException,crypto,console});
 return{store:module.exports,storage,events,window,localStorage};
}
function componentHooks(){
 let cursor=0,unmounted=false;const cells=[],effects=[],cleanups=[];
 const hooks={
  useState(initial){const index=cursor++;if(!(index in cells))cells[index]=typeof initial==='function'?initial():initial;return[cells[index],next=>{assert.equal(unmounted,false,'late UI write after unmount');cells[index]=typeof next==='function'?next(cells[index]):next;}];},
  useRef(initial){const index=cursor++;if(!(index in cells))cells[index]={current:initial};return cells[index];},
  useEffect(effect,deps){const index=cursor++,prior=cells[index];if(!prior||deps.some((value,i)=>value!==prior[i])){effects.push(()=>{cleanups[index]?.();cleanups[index]=effect();});cells[index]=deps;}},
  useId:()=> 'fixture-field',useCallback:callback=>callback,lazy:()=>()=>null,Suspense:'Suspense',
 };
 return{hooks,cells,render(fn){cursor=0;const tree=fn();for(const effect of effects.splice(0))effect();return tree;},unmount(){unmounted=true;for(const cleanup of cleanups)cleanup?.();}};
}
function loginUI(main){
 const environment=authStore(main.bridge),{store}=environment;
 const flowHooks=componentHooks(),accountHooks=componentHooks(),callbacks=[],timers=new Set();
 const jsx=(type,props)=>({type,props:props??{}}),Turnstile=()=>null;
 const window={...environment.window,setInterval(fn){timers.add(fn);return fn;},clearInterval:fn=>timers.delete(fn)};
 const context={window,localStorage:environment.localStorage,crypto,AbortController,AbortSignal,DOMException,Response,console};
 const fetcher=async(url,init)=>{
  const path=new URL(url).pathname,body=JSON.parse(init.body??'{}');
  if(path==='/auth/check')return Response.json({registered:true});
  if(path==='/auth/login')return Response.json(profile(body.account.split('@')[0]));
  throw Error('Unexpected auth request '+path);
 };
 const load=(code,imports)=>{const module={exports:{}};runInNewContext(code,{...context,fetch:fetcher,module,exports:module.exports,require:name=>{assert.ok(name in imports,name);return imports[name];}});return module.exports;};
 const authRequests=load(requestCode,{'@/utils/authStore':store,'./toraService':toraService});
 const shared={'@/lib/toraService':toraService,'react/jsx-runtime':{jsx,jsxs:jsx,Fragment:'Fragment'},'framer-motion':{motion:{section:'motion.section'},AnimatePresence:'AnimatePresence',useReducedMotion:()=>false},'lucide-react':{},'@/i18n/useI18n':{useTranslation:()=>({t:key=>key,i18n:{language:'en'}})},'@/utils/authStore':store};
 const{AuthFlow}=load(flowCode,{...shared,react:flowHooks.hooks,'./Turnstile':{Turnstile},'@/hooks/useMotionSettings':{useMotionSettings:()=>({effective:'off',pageEnabled:false,clickEnabled:false})},'@/lib/authFlow':authRequests,'./login-surface.css':{}});
 const{AccountSection}=load(accountCode,{...shared,react:accountHooks.hooks,'../auth/login-surface.css':{},'./AccountBenefits':{},'@/components/auth/AuthFlow':{AuthFlow},'@/components/auth/EnforcementPanel':{},'@/components/ui/button':{},'@/components/ui/dialog':{},'@/utils/authLogout':{signOutAccount:async()=>{}}});
 const account=()=>accountHooks.render(()=>AccountSection({mode:'auth',onAuthenticated:value=>callbacks.push(value)}));
 let tree;const render=()=>{const node=account();assert.equal(node.type,AuthFlow);tree=flowHooks.render(()=>AuthFlow(node.props));return tree;};
 const walk=(node,out=[])=>{if(Array.isArray(node)){for(const child of node)walk(child,out);}else if(node&&typeof node==='object'){out.push(node);walk(node.props?.children,out);}return out;};
 const find=predicate=>{const node=walk(tree).find(predicate);assert.ok(node,'Rendered element');return node;};
 render();
 return{store,callbacks,accountHooks,
  async click(label){const node=find(node=>(node.type?.name==='AuthAction'&&node.props.label==='authFlow.'+label)||(node.type==='button'&&node.props.children==='authFlow.'+label));assert.notEqual(node.props.disabled,true,label);node.props.onClick();await flush();render();},
  type(label,value){find(node=>node.type?.name==='AuthField'&&node.props.label==='authFlow.'+label).props.onChange(value);render();},
  async login(name){await this.click('continueLogin');this.type('email',`${name}@fixture.invalid`);await this.click('continue');this.type('password','fixture-password');await this.click('continue');},
  render,unmount(){flowHooks.unmount();accountHooks.unmount();},
 };
}

test('Profile commit writes one encrypted complete record and legacy field setters are not used',async()=>{
 const main=mainStore();let oldCalls=0;
 for(const key of ['setEmail','setUsername','setToken'])main.bridge[key]=async()=>{oldCalls++;throw Error('Individual setters must not be used for sign-in');};
 const{store,events}=authStore(main.bridge);assert.equal(typeof store.commitAuthProfile,'function');
 const receipt=await store.commitAuthProfile(profile('a'),operation());
 assert.equal(receipt.isCurrent(),true);assert.equal(main.writes,1);assert.equal(oldCalls,0);
 assert.equal(store.getToken(),profile('a').token);assert.equal(store.getEmail(),profile('a').email);assert.equal(store.getUsername(),profile('a').username);
 assert.ok(!main.disk.includes(profile('a').token));assert.ok(!main.disk.includes(profile('a').email));assert.deepEqual(events,['tora-auth-changed']);
});

test('A held commit canceled before persistence cannot overwrite B token/email after A resumes',async()=>{
 const main=mainStore(),{store}=authStore(main.bridge),controller=new AbortController(),wait=main.holdNext();
 const a=store.commitAuthProfile(profile('a'),operation(controller)).then(()=>null,error=>error);await flush();
 controller.abort();const b=await store.commitAuthProfile(profile('b'),operation());
 wait.resolve();assert.equal((await a).name,'AbortError');assert.equal(b.isCurrent(),true);
 assert.equal(store.getToken(),profile('b').token);assert.equal(store.getEmail(),profile('b').email);assert.equal(main.writes,1);
});

test('A delayed success reply after its atomic write cannot overwrite B UI or emit a late auth event',async()=>{
 const main=mainStore(),{store,events}=authStore(main.bridge),controller=new AbortController(),wait=main.holdNext('after');
 const a=store.commitAuthProfile(profile('a'),operation(controller)).then(()=>null,error=>error);await flush();assert.equal(main.writes,1);
 controller.abort();const b=await store.commitAuthProfile(profile('b'),operation(new AbortController(),profile('a').token));
 wait.resolve();assert.equal((await a).name,'AbortError');assert.equal(b.isCurrent(),true);
 assert.equal(store.getToken(),profile('b').token);assert.equal(store.getEmail(),profile('b').email);assert.equal(main.writes,2);assert.equal(events.length,1);
});

test('The real preload exposes only the dedicated profile begin/cancel/commit channels',async()=>{
 const exposed={},calls=[];
 runInNewContext(source('../../../preload.cjs'),{
  process:{platform:'darwin',isMainFrame:false},window:{},
  require:name=>{
   assert.equal(name,'electron');
   return{contextBridge:{exposeInMainWorld:(name,value)=>{exposed[name]=value;}},ipcRenderer:{sendSync:(...args)=>{calls.push(args);return 1;},invoke:async(...args)=>{calls.push(args);return true;}}};
  },
 });
 const id=crypto.randomUUID();assert.equal(exposed.toraAuth.beginProfileCommit(id,null),1);
 assert.equal(exposed.toraAuth.cancelProfileCommit(id,1),1);
 assert.equal(await exposed.toraAuth.commitProfile(id,1,profile('a')),true);
 assert.deepEqual(calls.map(args=>args[0]),['auth:begin-profile','auth:cancel-profile','auth:commit-profile']);
});

test('New auth IPC rejects subframes, webviews, other windows and missing main-frame identity',async()=>{
 const main=mainStore(),id=crypto.randomUUID(),fence=main.bridge.beginProfileCommit(id,null);
 for(const event of [{sender:{},senderFrame:{}},{sender:main.webContents,senderFrame:{}},{sender:main.webContents},{sender:main.webContents,senderFrame:null}]){
  assert.equal(main.sync('auth:begin-profile',[crypto.randomUUID(),null],event),null);
  assert.equal(main.sync('auth:cancel-profile',[id,fence],event),false);
  assert.equal(main.invoke('auth:commit-profile',[id,fence,profile('a')],event),false);
 }
 assert.equal(main.writes,0);assert.equal(await main.bridge.commitProfile(id,fence,profile('a')),true);assert.equal(main.writes,1);
});

test('Main-process CAS rejects changed-token, canceled and superseded operations without partial writes',async()=>{
 const main=mainStore(),idA=crypto.randomUUID(),idB=crypto.randomUUID();
 const a=main.bridge.beginProfileCommit(idA,null),b=main.bridge.beginProfileCommit(idB,null);
 assert.equal(await main.bridge.commitProfile(idA,a,profile('a')),false);
 assert.equal(main.bridge.cancelProfileCommit(idA,a),false);
 assert.equal(await main.bridge.commitProfile(idB,b,profile('b')),true);
 assert.equal(main.bridge.beginProfileCommit(crypto.randomUUID(),null),null);
 const c=main.bridge.beginProfileCommit(idA,profile('b').token);assert.equal(main.bridge.cancelProfileCommit(idA,c),true);
 assert.equal(await main.bridge.commitProfile(idA,c,profile('a')),false);
 const d=main.bridge.beginProfileCommit(idA,profile('b').token);await main.bridge.delToken();
 assert.equal(await main.bridge.commitProfile(idA,d,profile('a')),false);assert.equal(main.disconnects,1);
 assert.equal(main.pluginStops,1);
 assert.equal(main.bridge.getToken(),null);assert.equal(main.bridge.getEmail(),profile('b').email);
});

test('Browser fallback commits one canonical profile record and logout clears it without resurrecting legacy credentials',async()=>{
 const{store,storage}=authStore();storage.set('tora_auth_token','legacy-token');storage.set('tora_auth_email','legacy@fixture.invalid');
 const receipt=await store.commitAuthProfile(profile('b'),operation(new AbortController(),'legacy-token'));assert.equal(receipt.isCurrent(),true);
 assert.equal(store.getToken(),profile('b').token);assert.equal(store.getEmail(),profile('b').email);
 assert.ok(storage.has('tora_auth_profile'));await store.setEmail('changed@fixture.invalid');assert.equal(receipt.isCurrent(),false);
 assert.equal(store.getEmail(),'changed@fixture.invalid');await store.clearAll();assert.equal(store.getToken(),null);assert.equal(store.getEmail(),null);assert.equal(store.getUsername(),null);
});

test('Real AuthFlow -> AccountSection -> main persistence: cancel A, log in B, resolve A preserves B token/email/UI',async()=>{
 for(const phase of ['before','after']){
  const main=mainStore(),ui=loginUI(main),wait=main.holdNext(phase);
  await ui.login('a');await ui.click('cancel');await ui.login('b');
  assert.equal(ui.store.getToken(),profile('b').token);assert.equal(ui.store.getEmail(),profile('b').email);
  wait.resolve();await flush();ui.render();
  assert.equal(ui.store.getToken(),profile('b').token);assert.equal(ui.store.getEmail(),profile('b').email);
  assert.equal(ui.callbacks.length,1);assert.equal(ui.callbacks[0].email,profile('b').email);
  assert.equal(ui.accountHooks.cells[0].email,profile('b').email);
 }
});

test('Unmount while persistence is held cancels the fence and never writes late credentials or UI',async()=>{
 const main=mainStore(),ui=loginUI(main),wait=main.holdNext();await ui.login('a');ui.unmount();wait.resolve();await flush();
 assert.equal(main.writes,0);assert.equal(ui.store.getToken(),null);assert.equal(ui.store.getEmail(),null);assert.equal(ui.callbacks.length,0);
});

function loginGateUI(refreshAccount, initialToken=null) {
  let token=initialToken;
  const hooks=componentHooks(),timers=new Map(),listeners=new Map();
  const schedule=(callback,delay)=>{const id=Symbol();timers.set(id,{callback,delay});return id;};
  const cancel=id=>timers.delete(id);
  const jsx=(type,props)=>({type,props:props??{}});
  const imports={
   react:hooks.hooks,'react/jsx-runtime':{jsx,jsxs:jsx,Fragment:'Fragment'},'./login-surface.css':{},
   '@/components/auth/LoginAnimation':{BrandLogo:'BrandLogo',LogoLoader:'LogoLoader',SuccessCheck:'SuccessCheck'},
   '@/components/ui/button':{Button:'Button'},'@/i18n/useI18n':{useTranslation:()=>({t:key=>key})},
   '@/lib/toraService':toraService,'@/utils/authLogout':{signOutAccount:async()=>{token=null;}},
   '@/utils/authStore':{getToken:()=>token,delToken:async()=>{token=null;},delEmail:async()=>{}},
   '@/utils/modelSync':{syncModelsFromCloud:async()=>{}},
  };
  const module={exports:{}};
  runInNewContext(compile('../components/auth/LoginGate.tsx'),{
   module,exports:module.exports,require:name=>{assert.ok(name in imports,name);return imports[name];},
   window:{toraWindow:refreshAccount&&{refreshAccount},setTimeout:schedule,clearTimeout:cancel,
    addEventListener:(name,fn)=>listeners.set(name,fn),removeEventListener:name=>listeners.delete(name)},
   localStorage:{getItem:()=>null},setTimeout:schedule,clearTimeout:cancel,AbortController,
   fetch:async()=>{throw Error('Native verification should not need a second renderer request');},
  });
  const render=()=>hooks.render(()=>module.exports.LoginGate({children:'private-workspace'}));
  const walk=node=>Array.isArray(node)?node.flatMap(walk):node&&typeof node==='object'?[node,...walk(node.props?.children)]:[];
  render();const entry=render();
  const form=walk(entry).find(node=>typeof node.props?.onAuthenticated==='function');
  if (!initialToken) assert.ok(form);
  return{hooks,timers,listeners,walk,render,
    signIn(){token='fixture-authenticated-session';form.props.onAuthenticated();return render();},
    signOut(){token=null;},
  };
}

test('LoginGate never opens the workspace after credentials disappear during the success animation',()=>{
 for(const broadcastsLogout of [false,true]){
  const ui=loginGateUI();
  ui.signIn();
  assert.equal(ui.hooks.cells[0],'success');
  const transition=[...ui.timers.values()].find(timer=>timer.delay===1000);assert.ok(transition);
  ui.signOut();
  if(broadcastsLogout){ui.listeners.get('tora-auth-changed')();ui.render();assert.equal(ui.hooks.cells[0],'login');}
  transition.callback();const result=ui.render();
  assert.equal(ui.hooks.cells[0],'login');assert.notEqual(result,'private-workspace');ui.hooks.unmount();
 }
});

test('The native account gate waits for confirmation and retries an unavailable connection',async()=>{
 const first=deferred(), second=deferred();
 let count=0;
 const ui=loginGateUI(()=>++count===1?first.promise:second.promise);
 assert.notEqual(ui.signIn(),'private-workspace');
 assert.equal(ui.hooks.cells[0],'checking');
 assert.equal([...ui.timers.values()].some(timer=>timer.delay===1000),false);

 first.resolve({status:'unavailable'});await flush();
 const error=ui.render();
 assert.equal(ui.hooks.cells[0],'unavailable');
 ui.walk(error).find(node=>node.props?.children==='error.retry').props.onClick();
 ui.render();
 second.resolve({status:'ok'});await flush();ui.render();
 assert.equal(ui.hooks.cells[0],'success');
 [...ui.timers.values()].find(timer=>timer.delay===1000).callback();
 assert.equal(ui.render().props.children,'private-workspace');
 ui.hooks.unmount();
});

test('A hung native account check offers retry and ignores a late success',async()=>{
 const pending=deferred();
 const ui=loginGateUI(()=>pending.promise);
 ui.signIn();
 [...ui.timers.values()].find(timer=>timer.delay===12000).callback();
 await flush();
 assert.equal(ui.hooks.cells[0],'unavailable');
 pending.resolve({status:'ok'});await flush();
 assert.notEqual(ui.render().props.children,'private-workspace');
 assert.equal(ui.hooks.cells[0],'unavailable');
 ui.hooks.unmount();
});

test('Clearing the cached token during startup returns to login even when the old check finishes later',async()=>{
 for(const broadcastsLogout of [false,true]){
  const pending=deferred();
  const ui=loginGateUI(()=>pending.promise,'cached-session-fixture');
  assert.equal(ui.hooks.cells[0],'checking');
  ui.signOut();
  if(broadcastsLogout){
   ui.listeners.get('tora-auth-changed')();
   ui.render();
   assert.equal(ui.hooks.cells[0],'login');
  }
  pending.resolve({status:'ok'});
  await flush();
  const result=ui.render();
  assert.equal(ui.hooks.cells[0],'login');
  assert.ok(ui.walk(result).some(node=>typeof node.props?.onAuthenticated==='function'));
  ui.hooks.unmount();
 }
});
