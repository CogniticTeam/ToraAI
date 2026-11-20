import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import { randomUUID } from 'node:crypto';
const require = createRequire(new URL('../packages/desktop/frontend/package.json', import.meta.url));
const ts = require('typescript');
const base = new URL('../packages/desktop/frontend/src/', import.meta.url);
const tick = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };

// Execute the actual TS/TSX modules with deterministic hooks and controlled I/O.
// No fixture reaches a real user profile, browser, local server, or model API.
function harness(mocks = {}, globals = {}) {
  const slots = [], effects = [], layouts = [], storage = new Map();
  let cursor = 0, disposed = false, updatesAfterDispose = 0, rendering = false, renderAgain = false;
  const changed = (a, b) => !a || !b || a.length !== b.length || a.some((v, i) => !Object.is(v, b[i]));
  const effect = queue => (fn, deps) => {
    const i = cursor++; if (changed(slots[i]?.deps, deps)) { queue.push(() => { slots[i]?.cleanup?.(); slots[i] = { deps, cleanup: fn() }; }); }
  };
  const react = {
    useState(initial) { const i = cursor++; if (!(i in slots)) slots[i] = typeof initial === 'function' ? initial() : initial; return [slots[i], value => { if (disposed) updatesAfterDispose++; const next = typeof value === 'function' ? value(slots[i]) : value; if (rendering && !Object.is(next, slots[i])) renderAgain = true; slots[i] = next; }]; },
    useId() { const i = cursor++; return slots[i] ??= `fixture-${i}`; },
    useSyncExternalStore(_subscribe,get) {return get();},
    useRef(initial) { const i = cursor++; return slots[i] ??= { current: initial }; },
    useMemo(fn, deps) { const i = cursor++; if (changed(slots[i]?.deps, deps)) slots[i] = { deps, value: fn() }; return slots[i].value; },
    useCallback(fn, deps) { return react.useMemo(() => fn, deps); },
    useEffect: effect(effects), useLayoutEffect: effect(layouts), useImperativeHandle() {},
    lazy: () => 'Lazy', memo: fn => fn, forwardRef: fn => fn, createContext: value => ({ Provider: 'Provider', value }), useContext: ctx => ctx.value,
  };
  const jsx = (type, props, key) => ({ type, props, ...(key === undefined ? {} : { key }) });
  const window = { addEventListener() {}, removeEventListener() {}, dispatchEvent() {}, setTimeout: () => 1, clearTimeout() {}, setInterval: () => 1, clearInterval() {} };
  const audio = { disposeAll() {} };
  const imports = {
    '@/lib/uiCheckpoint':{restoreUIState:(_key,fallback)=>fallback,useUICheckpoint(){},restoreUIScroll:()=>()=>{},reportUIFailure(){}},
    './adapters/authStore': {getToken:()=> 'fixture-web-token'},
    '@/i18n': {__esModule:true,default:{language:'zh'}},
    react: { ...react, default: react }, 'react/jsx-runtime': { jsx, jsxs: jsx, Fragment: 'Fragment' },
    '@/i18n/useI18n': { useTranslation: () => ({ t: key => key, i18n: { language: 'zh' } }) },
    '@/i18n/useI18n.ts': { useTranslation: () => ({ t: key => key, i18n: { language: 'zh' } }) },
    '@/context/AudioContext': { useAudioManager: () => audio, AudioProvider: 'AudioProvider' },
    '@/hooks/useMotionSettings': {useMotionSettings:()=>({effective:'standard',pageEnabled:true,clickEnabled:true})},
    '@/hooks/useAgents': {useAgents:()=>({agents:[]})},
    '@/api/desktopPlugins': {getDesktopPluginBridge:()=>undefined,isDesktopPluginSkillId:()=>false,useDesktopPluginContributions:()=>undefined},
    '@/hooks/useAvailableModels': {useAvailableModels:()=>({groups:{},loading:false,refetch(){}}),isChatModelAvailable:(_groups,model)=>model.credential_id!=='tora-official'},
    'react-router-dom': {useNavigate:()=>()=>{},useParams:()=>({})},
    '@/lib/utils': { cn: (...values) => values.filter(Boolean).join(' ') },
    '@/lib/toraService': { authBaseURL: () => 'https://fixture.invalid' },
    '@/lib/catgirl': { useCatgirlSettings: () => ({ installed: false, enabled: false }), catgirlTrigger: () => null, catgirlCopy: () => ({}) },
    '@agentscope-ai/agentscope/event': { EventType: new Proxy({}, { get: (_, key) => key }) },
    '@agentscope-ai/agentscope/message': { UserMsg: data => ({ id: randomUUID(), role: 'user', ...data }), AssistantMsg: data => ({ id: randomUUID(), role: 'assistant', ...data }), appendEvent() {} },
    mime: { getType: () => 'image/png', getExtension: () => 'png' },
    ...mocks,
  };
  const context = { console, performance, crypto: { randomUUID }, Response, Request, Headers, AbortController, AbortSignal, DOMException, URL, URLSearchParams, structuredClone,
    window, document: { visibilityState: 'visible' }, localStorage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key) },
    setTimeout: () => 1, clearTimeout() {}, setInterval: () => 1, clearInterval() {},
    requestAnimationFrame: fn => { queueMicrotask(fn); return 1; }, cancelAnimationFrame() {},
    fetch: async () => { throw Error('Unexpected fetch'); }, ...globals };
  const sharedModelRules = ['deepseek-model.js', 'retired-doubao.js'];
  function loadSharedModelRule(name) {
    const file = sharedModelRules.find(rule => name.endsWith('/' + rule));
    return file ? load('../../../core/src/' + file) : undefined;
  }
  function load(path, append = '') {
    const source = readFileSync(new URL(path, base), 'utf8') + append;
    const output = ts.transpileModule(source, { fileName: path, compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
    const exports = {};
    vm.runInNewContext(output, { ...context, exports, require: name => imports[name] ?? loadSharedModelRule(name) ?? (name === '@/hooks/useRoleModel' ? load('hooks/useRoleModel.ts') : name === '@/lib/panelTabs' ? load('lib/panelTabs.ts') : name === '@/lib/browserStart' ? load('lib/browserStart.ts') : name === '@/lib/tochatModels' ? load('lib/tochatModels.ts') : name === '@/lib/subscription' ? load('lib/subscription.ts') : name === '@/lib/toolDisplayName' ? load('lib/toolDisplayName.ts') : name.endsWith('/chat-media.js') ? load('../../../core/src/chat-media.js') : name === '@/lib/chatAttachments' ? load('lib/chatAttachments.ts') : name.endsWith('/session-mode.js') ? load('../../../core/src/session-mode.js') : name.endsWith('/builtin-models.js') ? load('../../../core/src/builtin-models.js') : name.endsWith('/title-rules.js') ? load('../../../core/src/title-rules.js') : undefined) ?? new Proxy({}, { get: (_, key) => key === '__esModule' ? true : String(key) }) }, { filename: path });
    return exports;
  }
  const flushLayouts=()=>{for(const run of layouts.splice(0))run();};
  const flushEffects=()=>{flushLayouts();for(const run of effects.splice(0))run();};
  return { load, mock:(name,value)=>{imports[name]=value;}, render(fn,{deferEffects=false}={}) {
    let result, attempts=0;
    do {
      assert.ok(attempts++<25,'guarded render-state adjustments must settle');
      const layoutStart=layouts.length,effectStart=effects.length;
      cursor=0;renderAgain=false;rendering=true;
      try { result=fn(); } finally { rendering=false; }
      // React discards effects from a render retried by a guarded state adjustment.
      if(renderAgain){layouts.splice(layoutStart);effects.splice(effectStart);}
    } while(renderAgain);
    flushLayouts();if(!deferEffects)flushEffects();return result;
  }, flushEffects,
    dispose() { disposed = true; for (const slot of slots) slot?.cleanup?.(); }, get updatesAfterDispose() { return updatesAfterDispose; }, context };
}
function find(tree, predicate) {
  if (!tree) return null;
  if (Array.isArray(tree)) { for (const child of tree) { const found = find(child, predicate); if (found) return found; } return null; }
  if (typeof tree !== 'object') return null;
  return predicate(tree) ? tree : find(tree.props?.children, predicate);
}

test('权限菜单只接受三个模式并显示旧会话当前的限制', () => {
  const h = harness({ '@/lib/utils.ts': { cn: (...values) => values.filter(Boolean).join(' ') } });
  const { PermissionModeSelect } = h.load('components/select/PermissionModeSelect.tsx');
  const changes = [];
  const tree = h.render(() => PermissionModeSelect({ value: 'explore', onChange: value => changes.push(value) }));
  const trigger = find(tree, node => node.type === 'DropdownMenuTrigger');
  assert.ok(find(trigger, node => node.props?.children === 'permission-mode.explore'));
  const group = find(tree, node => node.type === 'DropdownMenuRadioGroup');
  assert.deepEqual(Array.from(group.props.children, item => item.props.value), ['default', 'accept_edits', 'bypass']);
  group.props.onValueChange('dont_ask');
  group.props.onValueChange('accept_edits');
  assert.deepEqual(changes, ['accept_edits']);
  h.dispose();
});

test('Agent Role model priority isolates drafts before effects and preserves first-send handoff', () => {
  const model = name => ({type:'openai_compatible',credential_id:'personal',model:name,parameters:{}});
  const restored=model('restored'), a=model('a-default'), b=model('b-default'), manual=model('manual'), persisted=model('persisted');
  let checkpoint;
  const h=harness({'@/lib/uiCheckpoint':{restoreUIState:()=>restored,useUICheckpoint:(_key,value)=>{checkpoint=value;}}});
  const {useRoleModel}=h.load('hooks/useRoleModel.ts');
  const options={agentId:'a',sessionId:null,defaultModel:a,sessionModel:undefined,checkpointKey:'code-model',groups:{},modelsLoading:false};
  const render=config=>h.render(()=>useRoleModel(options),config);
  assert.equal(render().model,restored);
  options.agentId='b';options.defaultModel=b;
  assert.equal(render({deferEffects:true}).model,b,'another role never sees the prior draft, even before effects');
  render().selectModel(manual);assert.equal(render().model,manual);
  options.defaultModel=model('changed-default');assert.equal(render().model,manual,'role refresh preserves an explicit choice');
  render().sessionCreated('fresh');options.sessionId='fresh';
  assert.equal(render({deferEffects:true}).model,manual,'created session keeps its submitted model while the list loads');
  options.sessionModel=persisted;assert.equal(render().model,persisted);
  options.sessionId=null;options.sessionModel=undefined;
  assert.equal(render().model.model,manual.model,'the next conversation remembers the last manual choice');
  assert.equal(Object.keys(render().model.parameters).length,0,'new conversations do not inherit model parameters');
  assert.equal(checkpoint,null,'inherited and persisted models are not saved as explicit drafts');
  h.dispose();
});

test('model preference survives remounts without parameters and stays separate for ToChat and ToCode', () => {
  const model = name => ({type:'openai_compatible',credential_id:'personal',model:name,parameters:{temperature:0.8,thinkingEffort:'max'}});
  const seed=harness(),localStorage=seed.context.localStorage;
  const options={agentId:'a',sessionId:null,defaultModel:model('role-default'),checkpointKey:'code-model',groups:{},modelsLoading:false};
  const mount=overrides=>{
    const h=harness({}, {localStorage}),{useRoleModel}=h.load('hooks/useRoleModel.ts');
    const config={...options,...overrides};
    return {h,config,render:()=>h.render(()=>useRoleModel(config))};
  };
  let code=mount();code.render().selectModel(model('code-choice'));code.h.dispose();
  assert.deepEqual(JSON.parse(localStorage.getItem('tora-last-model:code-model')),{type:'openai_compatible',credential_id:'personal',model:'code-choice'});
  code=mount();assert.equal(code.render().model.model,'code-choice');assert.equal(JSON.stringify(code.render().model.parameters),'{}');
  const stored=localStorage.getItem('tora-last-model:code-model');
  code.config.sessionId='existing';code.config.sessionModel=model('saved-history');
  assert.equal(code.render().model,code.config.sessionModel);
  code.config.sessionModel=null;assert.equal(code.render().model,null,'history without a model does not inherit the preference');
  assert.equal(localStorage.getItem('tora-last-model:code-model'),stored,'viewing history does not update the preference');
  code.config.sessionId=null;code.config.sessionModel=undefined;assert.equal(code.render().model.model,'code-choice');
  let chat=mount({checkpointKey:'tochat-custom',draftKey:'chat'});
  assert.equal(chat.render().model.model,'role-default');chat.render().selectModel(model('chat-choice'));chat.h.dispose();
  chat=mount({checkpointKey:'tochat-custom',draftKey:'work'});
  assert.equal(chat.render().model.model,'chat-choice','ToChat chat and work share one preference');
  assert.equal(JSON.stringify(chat.render().model.parameters),'{}');
  assert.equal(code.render().model.model,'code-choice','ToChat never overwrites ToCode');
  code.h.dispose();chat.h.dispose();seed.dispose();
});

test('model preference falls back when unavailable or damaged and never blocks selection on storage failure', () => {
  const saved={type:'openai_compatible',credential_id:'cocode-models',model:'remembered'};
  const defaults={...saved,model:'role-default',parameters:{}};
  for(const raw of [JSON.stringify(saved),'not-json','null','[]',JSON.stringify({...saved,model:42}),JSON.stringify({...saved,credential_id:null})]){
    let loading=true,groups={};
    const h=harness({}, {localStorage:{getItem:()=>raw,setItem(){throw Error('storage unavailable');}}});
    const {isChatModelAvailable}=h.load('hooks/useAvailableModels.ts');h.mock('@/hooks/useAvailableModels',{isChatModelAvailable});
    const {useRoleModel}=h.load('hooks/useRoleModel.ts');
    const render=()=>h.render(()=>useRoleModel({agentId:'a',sessionId:null,defaultModel:defaults,checkpointKey:'code-model',groups,modelsLoading:loading}));
    if(raw===JSON.stringify(saved))assert.equal(render().model.model,'remembered');
    loading=false;assert.equal(render().model,defaults,'missing credentials fall back after the catalog loads');
    groups={openai_compatible:[{credential:{id:'cocode-models',data:{source:'models-config'}},models:[{name:'other'}]}]};
    assert.equal(render().model,defaults,'disabled or removed models fall back');
    const next={...defaults,model:'manual',parameters:{thinkingEffort:'high'}};
    assert.doesNotThrow(()=>render().selectModel(next));assert.equal(render().model,next);
    h.dispose();
  }
  const h=harness({}, {localStorage:{getItem(){throw Error('storage unavailable');},setItem(){throw Error('storage unavailable');}}});
  const {useRoleModel}=h.load('hooks/useRoleModel.ts');
  const render=()=>h.render(()=>useRoleModel({agentId:'a',sessionId:null,defaultModel:defaults,checkpointKey:'code-model',groups:{},modelsLoading:false}));
  assert.equal(render().model,defaults);render().selectModel(defaults);assert.equal(render().model,defaults);h.dispose();
});

test('Agent Role loading session never falls back to a role default or unrelated draft', () => {
  const model={type:'openai_compatible',credential_id:'personal',model:'role-default',parameters:{}};
  const h=harness();const {useRoleModel}=h.load('hooks/useRoleModel.ts');
  const options={agentId:'a',sessionId:null,defaultModel:model,checkpointKey:'tochat-custom',pending:true,groups:{},modelsLoading:false};
  const render=()=>h.render(()=>useRoleModel(options));
  assert.equal(render().model,null);options.pending=false;options.sessionId='existing';
  assert.equal(render().model,null);options.sessionModel={...model,model:'saved-session'};
  assert.equal(render().model.model,'saved-session');options.defaultModel={...model,model:'new-role-default'};
  assert.equal(render().model.model,'saved-session');h.dispose();
});

test('Agent Role model availability matches credential as well as model name', () => {
  const h=harness();const {isChatModelAvailable}=h.load('hooks/useAvailableModels.ts');
  const groups={openai_compatible:[{credential:{id:'one',data:{}},models:[{name:'same-model'}]},{credential:{id:'two',data:{}},models:[{name:'other-model'}]},{credential:{id:'cocode-models',data:{source:'models-config'}},models:[{name:'enabled-model'}]}]};
  const model={type:'openai_compatible',credential_id:'one',model:'same-model',parameters:{}};
  assert.equal(isChatModelAvailable(groups,model),true);
  assert.equal(isChatModelAvailable(groups,{...model,credential_id:'two'}),true,'a global catalog is not authoritative for independent credentials');
  assert.equal(isChatModelAvailable(groups,{...model,credential_id:'deleted'}),false);
  assert.equal(isChatModelAvailable(groups,{...model,credential_id:'cocode-models'}),false,'the synthetic model list remains authoritative');
  assert.equal(isChatModelAvailable(groups,{...model,type:'constructor'}),false);
  assert.equal(isChatModelAvailable(groups,{...model,type:'__proto__'}),false);
  assert.equal(isChatModelAvailable(groups,{...model,credential_id:''}),true,'CLI/default-endpoint selections remain usable');
  h.dispose();
});

test('Agent Role avatar conversion validates files and stores only a small raster image', async () => {
  let closed=0,decoded=0,draw;
  const bitmap={width:400,height:200,close(){closed++;}};
  const canvas={getContext:()=>({drawImage:(...args)=>{draw=args;}}),toDataURL:type=>type+':encoded'};
  const h=harness({}, {createImageBitmap:async()=>{decoded++;return bitmap;},document:{createElement:()=>canvas}});
  const {readRoleAvatar}=h.load('lib/agentRoleAvatar.ts');
  const header=new Uint8Array(24);header.set([137,80,78,71,13,10,26,10]);header.set([73,72,68,82],12);
  const dimensions=new DataView(header.buffer);dimensions.setUint32(16,400);dimensions.setUint32(20,200);
  const file={type:'image/png',size:64,arrayBuffer:async()=>header.buffer};
  assert.equal(await readRoleAvatar(file),'image/png:encoded');
  assert.equal(canvas.width,128);assert.equal(canvas.height,128);
  assert.deepEqual(Array.from(draw.slice(1)),[100,0,200,200,0,0,128,128]);assert.equal(closed,1);
  await assert.rejects(readRoleAvatar({...file,type:'image/svg+xml'}),/Invalid avatar/);
  await assert.rejects(readRoleAvatar({...file,size:5*1024*1024+1}),/Invalid avatar/);
  await assert.rejects(readRoleAvatar({...file,arrayBuffer:async()=>new Uint8Array(12).buffer}),/Invalid avatar/);
  const huge=header.slice();new DataView(huge.buffer).setUint32(16,16384);new DataView(huge.buffer).setUint32(20,16384);
  await assert.rejects(readRoleAvatar({...file,arrayBuffer:async()=>huge.buffer}),/Invalid avatar dimensions/);
  assert.equal(decoded,1,'oversized pixel dimensions are rejected before image decoding');
  const jpeg=new Uint8Array([255,216,255,192,0,11,8,0,200,1,144,1,1,17,0,255,217]);
  assert.equal(await readRoleAvatar({...file,type:'image/jpeg',arrayBuffer:async()=>jpeg.buffer}),'image/png:encoded');
  const webp=new Uint8Array(30),webpView=new DataView(webp.buffer);
  webp.set([82,73,70,70]);webpView.setUint32(4,22,true);webp.set([87,69,66,80,86,80,56,88],8);webpView.setUint32(16,10,true);
  webp[24]=143;webp[25]=1;webp[27]=199;
  assert.equal(await readRoleAvatar({...file,type:'image/webp',arrayBuffer:async()=>webp.buffer}),'image/png:encoded');
  assert.equal(closed,3);h.dispose();
});

test('Agent Role editor locks Covey, patches only dirty fields and retains drafts through model setup', async () => {
  const model=name=>({type:'openai_compatible',credential_id:'personal',model:name,parameters:{}});
  const calls=[],a=model('one'),b=model('two'),c=model('three');
  let agents=[{id:'covey',builtin:'covey',editable:false,data:{name:'Covey',system_prompt:''}},{id:'custom',editable:true,data:{name:'Ada',personality:'original',system_prompt:'old instructions',chat_model_config:a}}];
  let draft=null,modelSetups=0;
  const onDraftChange=value=>{draft=typeof value==='function'?value(draft):value;};
  const mocks={'@/hooks/useAgents':{useAgents:()=>({agents,loading:false,error:null,refetch:async()=>{},create:async()=>{throw Error('unexpected create');},update:async(id,patch)=>{calls.push({id,patch});agents=agents.map(agent=>agent.id===id?{...agent,data:{...agent.data,...patch}}:agent);}})}};
  let h=harness(mocks),{AgentSection}=h.load('components/dialog/SettingsDialog.tsx','\nexport {AgentSection};');
  const render=()=>h.render(()=>AgentSection({draft,onDraftChange,onAddModel:()=>{modelSetups++;}}));
  const field=(tree,id)=>find(tree,node=>node.props?.id===id);
  render();let tree=render();
  for(const id of ['agent-role-name','agent-role-personality','agent-role-instructions','agent-role-default-model'])assert.equal(field(tree,id).props.disabled,true,id);
  field(tree,'agent-role-name').props.onChange({target:{value:'not allowed'}});find(tree,node=>node.type==='form').props.onSubmit({preventDefault(){}});
  assert.equal(draft.agentId,'covey');assert.equal(Object.keys(draft.overrides).length,0);assert.equal(calls.length,0);
  find(tree,node=>node.type==='button'&&find(node,child=>child.type==='span'&&child.props.children==='Ada')).props.onClick();
  tree=render();assert.equal(field(tree,'agent-role-default-model').props.value,a);
  agents=agents.map(agent=>agent.id==='custom'?{...agent,data:{...agent.data,chat_model_config:b,system_prompt:'fresh instructions'}}:agent);
  tree=render();assert.equal(field(tree,'agent-role-default-model').props.value,b);assert.equal(field(tree,'agent-role-instructions').props.value,'fresh instructions');
  field(tree,'agent-role-personality').props.onChange({target:{value:'patient'}});tree=render();
  const dirty=draft;find(tree,node=>node.type==='button'&&node.props['aria-pressed']===true).props.onClick();assert.equal(draft,dirty,'clicking the selected role does not reset it');
  agents=agents.map(agent=>agent.id==='custom'?{...agent,data:{...agent.data,chat_model_config:c}}:agent);tree=render();
  find(tree,node=>node.type==='form').props.onSubmit({preventDefault(){}});await tick();tree=render();
  assert.deepEqual(Object.keys(calls[0].patch),['personality']);assert.equal(calls[0].patch.personality,'patient');assert.equal(field(tree,'agent-role-default-model').props.value,c);
  find(tree,node=>node.type==='Button'&&Array.isArray(node.props.children)&&node.props.children.includes('agentSection.add')).props.onClick();tree=render();
  field(tree,'agent-role-name').props.onChange({target:{value:'New role'}});tree=render();
  field(tree,'agent-role-personality').props.onChange({target:{value:'warm'}});tree=render();
  field(tree,'agent-role-default-model').props.onChange(b);tree=render();field(tree,'agent-role-default-model').props.onAddCredential();assert.equal(modelSetups,1);
  h.dispose();h=harness(mocks);({AgentSection}=h.load('components/dialog/SettingsDialog.tsx','\nexport {AgentSection};'));tree=render();
  assert.equal(field(tree,'agent-role-name').props.value,'New role');assert.equal(field(tree,'agent-role-personality').props.value,'warm');assert.equal(field(tree,'agent-role-default-model').props.value,b);h.dispose();
});

test('Agent Role harness commits layouts before deferred passive effects and discards retried render effects', () => {
  const h=harness(),events=[];
  const {useState,useLayoutEffect,useEffect}=h.load('components/dialog/SettingsDialog.tsx','\nexport {useState,useLayoutEffect,useEffect};');
  let value='A';
  const render=()=>h.render(()=>{
    const committed=value;
    const [previous,setPrevious]=useState(committed);
    if(previous!==committed)setPrevious(committed);
    useLayoutEffect(()=>{events.push('layout:'+committed);return()=>events.push('layout-cleanup:'+committed);},[committed]);
    useEffect(()=>{events.push('passive:'+committed);return()=>events.push('passive-cleanup:'+committed);},[committed]);
    return previous;
  },{deferEffects:true});
  assert.equal(render(),'A');assert.deepEqual(events,['layout:A']);
  value='B';assert.equal(render(),'B');assert.deepEqual(events,['layout:A','layout-cleanup:A','layout:B']);
  h.flushEffects();assert.ok(events.indexOf('layout:B')<events.indexOf('passive:A'));
  assert.equal(events.filter(value=>value==='layout:B').length,1,'a discarded render never commits its layout');
  h.dispose();assert.ok(events.indexOf('layout-cleanup:B')<events.indexOf('passive-cleanup:B'));
});

test('Agent Role moderation API preserves string codes, detail fallbacks and toast behavior', async () => {
  const notifications=[];let response;
  const h=harness({sonner:{toast:{error:value=>notifications.push(value)}}},{fetch:async()=>response});
  h.context.localStorage.setItem('server_url','https://fixture.invalid');
  const {client,ApiError}=h.load('api/client.ts');
  const legacy=new ApiError(400,'legacy detail');assert.equal(legacy.message,'legacy detail');assert.equal(legacy.code,undefined);
  const coded=new ApiError(422,'blocked','ROLE_MODERATION_BLOCKED');assert.equal(coded.code,'ROLE_MODERATION_BLOCKED');
  for(const item of [
    {body:{detail:'provider detail',code:'ROLE_MODERATION_BLOCKED'},detail:'provider detail',code:'ROLE_MODERATION_BLOCKED'},
    {body:{detail:{reason:'validation'},code:'ROLE_REVIEW_STALE'},detail:'{"reason":"validation"}',code:'ROLE_REVIEW_STALE'},
    {body:{code:'ROLE_AGE_REQUIRED'},detail:'{"code":"ROLE_AGE_REQUIRED"}',code:'ROLE_AGE_REQUIRED'},
    ...[null,42,{},[]].map(code=>({body:{detail:'detail',code},detail:'detail',code:undefined})),
    {text:'<html>unavailable</html>',detail:'<html>unavailable</html>'},
    {text:'',detail:'Unavailable'},
    {text:'null',detail:'null'},
  ]) {
    response=new Response(item.text??JSON.stringify(item.body),{status:503,statusText:'Unavailable'});
    await assert.rejects(client.get('/failure'),error=>{
      assert.ok(error instanceof ApiError);assert.equal(error.status,503);assert.equal(error.detail,item.detail);
      assert.equal(error.message,item.detail);assert.equal(error.code,item.code);return true;
    });
    assert.equal(notifications.at(-1),item.detail);
  }
  const count=notifications.length;response=Response.json({detail:'private',code:'ROLE_AGE_REQUIRED'},{status:409});
  await assert.rejects(client.post('/agent/',{},undefined,{silent:true}),error=>error.code==='ROLE_AGE_REQUIRED');
  assert.equal(notifications.length,count,'silent callers still own their error UI');
  response=new Response(null,{status:204});assert.equal(await client.patch('/agent/one',{}),undefined);
  response=Response.json({agent_id:'created'});assert.equal((await client.post('/agent/',{})).agent_id,'created');h.dispose();
});

test('Agent Role moderation API keeps network, cancellation and timeout errors unchanged', async () => {
  const notifications=[];let failure;
  const h=harness({sonner:{toast:{error:value=>notifications.push(value)}}},{fetch:async()=>{throw failure;}});
  h.context.localStorage.setItem('server_url','https://fixture.invalid');
  const {client,ApiError,TIMEOUT_STATUS}=h.load('api/client.ts');
  failure=Error('synthetic network failure');
  await assert.rejects(client.get('/failure'),error=>error instanceof ApiError&&error.status===0&&error.code===undefined&&error.detail==='Cannot reach the server. Check the server address and your network.');
  failure=new DOMException('cancelled','AbortError');const count=notifications.length;
  await assert.rejects(client.get('/failure'),error=>error===failure);assert.equal(notifications.length,count);
  failure=new DOMException('deadline','TimeoutError');
  await assert.rejects(client.stream('/failure',{silent:true}),error=>error instanceof ApiError&&error.status===TIMEOUT_STATUS&&error.code===undefined&&error.detail==='The server took too long to respond.');
  assert.equal(notifications.length,count);h.dispose();
});

test('Agent Role age declaration is optional and request-only in the real TypeScript interfaces', () => {
  const source=ts.createSourceFile('types.ts',readFileSync(new URL('api/types.ts',base),'utf8'),ts.ScriptTarget.Latest,true);
  const members=name=>source.statements.find(node=>ts.isInterfaceDeclaration(node)&&node.name.text===name).members;
  for(const name of ['CreateAgentRequest','UpdateAgentRequest']) {
    const age=members(name).find(member=>member.name?.getText(source)==='age_confirmation');
    assert.ok(age?.questionToken,name);assert.equal(age.type.getText(source),"'adult' | 'minor'");
  }
  for(const name of ['AgentData','AgentView'])assert.ok(!members(name).some(member=>member.name?.getText(source)==='age_confirmation'),name);
});

const roleModerationCopy={
  'agentSection.checking':'正在进行 AI 内容检测…',
  'agentSection.ageTitle':'您是否已满18岁？',
  'agentSection.ageAdult':'已满18岁',
  'agentSection.ageMinor':'未满18岁',
  'agentSection.ageRestricted':'未满18岁不能创建虚拟感情陪伴类智能体。',
};

// Run real API/editor code with controlled hooks and I/O, never a server or model.
function roleModerationFixture({creating=false}={}) {
  const model={type:'openai_compatible',credential_id:'personal',model:'fixture-model',parameters:{temperature:0.5,nested:{budget:100}}};
  let agents=[
    {id:'custom',editable:true,updated_at:'initial',data:{name:'Ada',avatar:'data:image/png;base64,fixture',personality:'original',system_prompt:'original instructions',chat_model_config:model,context_config:{trigger_ratio:0.8}}},
    {id:'other',editable:true,data:{name:'Lin',system_prompt:'other instructions'}},
  ];
  let draft={agentId:creating?null:'custom',overrides:creating?{name:'  Partner  ',personality:'warm',system_prompt:'Virtual emotional companion',chat_model_config:structuredClone(model)}:{name:'  Ada Lovelace  ',personality:'patient'}};
  const requests=[],writes=[],notifications=[],storageWrites=[],storage=new Map([['server_url','https://fixture.invalid']]);
  let h,AgentSection,modelSetups=0;
  const onDraftChange=value=>{draft=typeof value==='function'?value(draft):value;};
  function mount() {
    h=harness({
      sonner:{toast:{error:value=>notifications.push(value)}},
      '@/i18n/useI18n':{useTranslation:()=>({t:(key,values)=>roleModerationCopy[key]??(values?.error?`${key}: ${values.error}`:key)})},
      '@/lib/agentRoleAvatar':{readRoleAvatar:async()=> 'data:image/png;base64,new-avatar'},
    },{
      localStorage:{getItem:key=>storage.get(key)??null,setItem:(key,value)=>{storageWrites.push([key,value]);storage.set(key,value);},removeItem:key=>{storageWrites.push([key,null]);storage.delete(key);}},
      fetch:async(url,init)=>{const gate=deferred();requests.push({path:new URL(url).pathname,method:init.method,body:JSON.parse(init.body),gate});return gate.promise;},
    });
    const api=h.load('api/client.ts');h.mock('@/api/client',api);h.mock('./client',api);
    const {agentApi}=h.load('api/agent.ts');
    h.mock('@/hooks/useAgents',{useAgents:()=>({agents,loading:false,error:null,refetch:async()=>agents,
      create:async(body,options)=>{const result=await agentApi.create(body,options);writes.push(structuredClone(body));const {age_confirmation:_,...data}=body;agents=[...agents,{id:result.agent_id,editable:true,data}];return result;},
      update:async(id,body,options)=>{const result=await agentApi.update(id,body,options);writes.push(structuredClone(body));agents=agents.map(agent=>agent.id===id?result:agent);return result;},
    })});
    ({AgentSection}=h.load('components/dialog/SettingsDialog.tsx','\nexport {AgentSection};'));
  }
  mount();
  const render=config=>h.render(()=>AgentSection({draft,onDraftChange,onAddModel:()=>{modelSetups++;}}),config);
  const reply=async(index,response)=>{assert.ok(requests[index],`request ${index} exists`);requests[index].gate.resolve(response);await tick();await tick();};
  return {render,requests,writes,notifications,storageWrites,
    get h(){return h;},get draft(){return draft;},set draft(value){draft=value;},get agents(){return agents;},set agents(value){agents=value;},get modelSetups(){return modelSetups;},
    field:id=>find(render(),node=>node.props?.id===id),
    button:key=>find(render(),node=>node.type==='Button'&&node.props.children===(roleModerationCopy[key]??key)),
    dialog:()=>find(render(),node=>node.type==='Dialog'),
    submit(config){find(render(config),node=>node.type==='form').props.onSubmit({preventDefault(){}});},
    reject:(index,code,status=409)=>reply(index,Response.json({detail:'UNTRUSTED PROVIDER DETAIL',code},{status})),
    accept(index){const request=requests[index];const {age_confirmation:_,...body}=request.body;return reply(index,Response.json(request.method==='POST'?{agent_id:'created'}:{...agents.find(agent=>request.path.endsWith('/'+agent.id)),data:{...agents.find(agent=>request.path.endsWith('/'+agent.id))?.data,...body}}));},
    remount(){h.dispose();mount();return render();},
  };
}

async function openRoleAgeChallenge(f) {
  const index=f.requests.length;f.submit();await f.reject(index,'ROLE_AGE_REQUIRED');
  assert.equal(f.dialog().props.open,true);assert.equal(f.draft.saving,undefined);return index;
}

test('Agent Role moderation create resubmits a detached exact snapshot and locks both submissions', async () => {
  const f=roleModerationFixture({creating:true});
  let tree=f.render();assert.ok(find(tree,node=>node.props?.children==='agentSection.moderationHint'));
  const submit=find(tree,node=>node.type==='form').props.onSubmit;
  submit({preventDefault(){}});submit({preventDefault(){}});assert.equal(f.requests.length,1);
  tree=f.render();
  assert.equal(find(tree,node=>node.props?.role==='status').props.children,'正在进行 AI 内容检测…');
  assert.equal(find(tree,node=>node.props?.role==='status').props['aria-live'],'polite');
  for(const id of ['agent-role-name','agent-role-personality','agent-role-instructions','agent-role-default-model'])assert.equal(f.field(id).props.disabled,true,id);
  f.field('agent-role-name').props.onChange({target:{value:'must not replace submitted name'}});
  f.field('agent-role-default-model').props.onAddCredential();assert.equal(f.modelSetups,0);
  const original=structuredClone(f.requests[0].body);assert.equal(original.name,'Partner');assert.equal('age_confirmation' in original,false);
  await f.reject(0,'ROLE_AGE_REQUIRED');tree=f.render();
  assert.equal(f.dialog().props.open,true);assert.ok(find(tree,node=>node.type==='DialogTitle'&&node.props.children==='您是否已满18岁？'));
  assert.ok(find(tree,node=>node.type==='DialogDescription'&&node.props.children==='agentSection.ageDescription'));
  assert.match(find(tree,node=>node.type==='DialogContent').props.className,/max-h-\[calc\(100dvh-2rem\)\].*overflow-y-auto/);
  const adult=f.button('agentSection.ageAdult');assert.ok(f.button('agentSection.ageMinor'));
  // A mutable nested model object cannot mutate the captured network body.
  f.draft.overrides.chat_model_config.parameters.nested.budget=999;
  adult.props.onClick();adult.props.onClick();assert.equal(f.requests.length,2);
  assert.deepEqual(f.requests[1].body,{...original,age_confirmation:'adult'});
  assert.equal(f.dialog().props.open,false);assert.equal(f.field('agent-role-name').props.disabled,true);
  await f.accept(1);assert.equal(f.writes.length,1);assert.equal(f.draft.agentId,'created');assert.equal(Object.keys(f.draft.overrides).length,0);
  assert.equal(f.draft.saving,undefined);assert.equal('age_confirmation' in f.draft,false);assert.equal(f.storageWrites.length,0);assert.equal(f.notifications.length,0);f.h.dispose();
});

test('Agent Role moderation pending status only claims AI checking for actual text changes', async () => {
  for(const [overrides,checking] of [
    [{avatar:null},false],
    [{chat_model_config:null},false],
    [{name:'  Ada  '},false],
    [{personality:'original'},false],
    [{system_prompt:'original instructions'},false],
    [{name:'ADA'},true],
    [{personality:'changed'},true],
    [{system_prompt:'changed instructions'},true],
    [{avatar:null,personality:'changed'},true],
  ]) {
    const f=roleModerationFixture();f.draft={agentId:'custom',overrides};f.submit();
    let tree=f.render();const button=find(tree,node=>node.type==='Button'&&node.props.type==='submit');
    assert.equal(button.props.disabled,true);assert.equal(button.props['aria-busy'],true);assert.ok(find(button,node=>node.type==='Loader2'));
    assert.equal(find(tree,node=>node.props?.role==='status').props.children,checking?'正在进行 AI 内容检测…':'');
    f.agents[0].data.personality='refetched while saving';tree=f.render();
    assert.equal(find(tree,node=>node.props?.role==='status').props.children,checking?'正在进行 AI 内容检测…':'','pending status belongs to the captured operation');
    await f.accept(0);assert.equal(find(f.render(),node=>node.props?.role==='status').props.children,'agentSection.saved');f.h.dispose();
  }
  const f=roleModerationFixture();f.draft={agentId:'custom',overrides:{avatar:null}};f.submit();f.remount();
  assert.equal(find(f.render(),node=>node.props?.role==='status').props.children,'','a remount without its local snapshot makes no AI-review claim');
  assert.equal(f.field('agent-role-name').props.disabled,true);await f.accept(0);assert.equal(f.draft.saving,undefined);f.h.dispose();
});

test('Agent Role moderation PATCH keeps dirty-only snapshot and releases the current draft identity on adult failure', async () => {
  const f=roleModerationFixture();await openRoleAgeChallenge(f);
  assert.deepEqual(f.requests[0].body,{name:'Ada Lovelace',personality:'patient'});
  assert.equal(f.field('agent-role-instructions').props.value,'original instructions');
  // Parent re-renders may supply an equivalent draft with a new identity.
  f.draft={...f.draft,overrides:{...f.draft.overrides}};
  f.button('agentSection.ageAdult').props.onClick();assert.equal(f.draft.saving,true);
  assert.deepEqual(f.requests[1].body,{...f.requests[0].body,age_confirmation:'adult'});
  await f.reject(1,'ROLE_MODERATION_BLOCKED',422);
  assert.equal(f.draft.saving,undefined);assert.equal(f.field('agent-role-name').props.value,'  Ada Lovelace  ');
  assert.equal(find(f.render(),node=>node.props?.role==='alert').props.children,'agentSection.moderationBlocked');
  assert.equal(f.dialog().props.open,false);assert.equal(f.writes.length,0);assert.equal(f.notifications.length,0);
  f.submit();assert.equal('age_confirmation' in f.requests[2].body,false,'adult is never remembered for the next attempt');f.h.dispose();
  await f.reject(2,'ROLE_MODERATION_UNAVAILABLE',503);assert.equal(f.h.updatesAfterDispose,0);
});

test('Agent Role moderation errors use fixed localized messages and preserve the full draft', async () => {
  for(const [code,status,key] of [
    ['ROLE_MODERATION_BLOCKED',422,'agentSection.moderationBlocked'],
    ['ROLE_AGE_RESTRICTED',403,'agentSection.ageRestricted'],
    ['ROLE_MODERATION_UNAVAILABLE',503,'agentSection.moderationUnavailable'],
    ['ROLE_MODERATION_TIMEOUT',504,'agentSection.moderationTimeout'],
    ['ROLE_REVIEW_STALE',409,'agentSection.moderationStale'],
  ]) {
    const f=roleModerationFixture({creating:true}),before=structuredClone(f.draft);f.submit();await f.reject(0,code,status);
    assert.deepEqual(f.draft,before,code);assert.equal(f.draft.saving,undefined,code);
    const tree=f.render();assert.equal(find(tree,node=>node.props?.role==='alert').props.children,roleModerationCopy[key]??key,code);
    assert.ok(!JSON.stringify(tree).includes('UNTRUSTED PROVIDER DETAIL'),code);assert.equal(f.dialog().props.open,false);
    assert.equal(f.writes.length,0);assert.equal(f.notifications.length,0);f.h.dispose();
  }
});

test('Agent Role moderation minor and Dialog dismissal do not resubmit or declare adulthood', async () => {
  // Escape, outside click and the close button share Dialog.onOpenChange(false).
  for(const action of ['minor','dismiss']) {
    const f=roleModerationFixture({creating:true}),before=structuredClone(f.draft);await openRoleAgeChallenge(f);
    const staleAdult=f.button('agentSection.ageAdult');
    if(action==='minor')f.button('agentSection.ageMinor').props.onClick();else f.dialog().props.onOpenChange(false);
    assert.equal(f.dialog().props.open,false);assert.deepEqual(f.draft,before);assert.equal(f.requests.length,1);assert.equal(f.writes.length,0);
    if(action==='minor')assert.equal(find(f.render(),node=>node.props?.role==='alert').props.children,'未满18岁不能创建虚拟感情陪伴类智能体。');
    staleAdult.props.onClick();assert.equal(f.requests.length,1);
    await openRoleAgeChallenge(f);assert.equal('age_confirmation' in f.requests[1].body,false);
    staleAdult.props.onClick();assert.equal(f.requests.length,2,'an old button cannot confirm a newer challenge');
    f.dialog().props.onOpenChange(false);assert.equal(f.storageWrites.length,0);f.h.dispose();
  }
});

test('Agent Role moderation invalidates age on edits, avatar changes, role/add selection and model setup', async () => {
  for(const action of ['name','personality','instructions','model','avatar','upload','role','add','add-model']) {
    const f=roleModerationFixture();await openRoleAgeChallenge(f);const staleAdult=f.button('agentSection.ageAdult');
    if(['name','personality','instructions'].includes(action))f.field('agent-role-'+action).props.onChange({target:{value:'edited '+action}});
    if(action==='model')f.field('agent-role-default-model').props.onChange({type:'openai_compatible',credential_id:'personal',model:'new-model',parameters:{}});
    if(action==='avatar')f.button('agentSection.removeAvatar').props.onClick();
    if(action==='upload')find(f.render(),node=>node.type==='input'&&node.props.type==='file').props.onChange({target:{files:[{}],value:'chosen'}});
    if(action==='role')find(f.render(),node=>node.type==='button'&&find(node,child=>child.type==='span'&&child.props.children==='Lin')).props.onClick();
    if(action==='add')find(f.render(),node=>node.type==='Button'&&Array.isArray(node.props.children)&&node.props.children.includes('agentSection.add')).props.onClick();
    if(action==='add-model')f.field('agent-role-default-model').props.onAddCredential();
    await tick();assert.equal(f.dialog().props.open,false,action);staleAdult.props.onClick();assert.equal(f.requests.length,1,action);assert.equal(f.writes.length,0);
    if(action==='add-model') {
      const before=structuredClone(f.draft);assert.equal(f.modelSetups,1);f.remount();assert.deepEqual(f.draft,before);
      assert.equal(f.field('agent-role-name').props.value,'  Ada Lovelace  ');assert.equal(f.dialog().props.open,false);
    }
    f.h.dispose();
  }
});

test('Agent Role moderation ignores unchanged refetches but invalidates changed effective role data before effects', async () => {
  for(const action of ['text','metadata','model','timestamp','readonly','deleted']) {
    const f=roleModerationFixture();await openRoleAgeChallenge(f);const staleAdult=f.button('agentSection.ageAdult');
    f.agents=structuredClone(f.agents);assert.equal(f.dialog().props.open,true,'equal refetches preserve a valid challenge');
    const old=structuredClone(f.agents),agent=f.agents[0];
    if(action==='text')agent.data.name='externally changed but masked by the draft';
    if(action==='metadata')agent.data.context_config.trigger_ratio=0.5;
    if(action==='model')agent.data.chat_model_config.model='external-model';
    if(action==='timestamp')agent.updated_at='new';
    if(action==='readonly')agent.editable=false;
    if(action==='deleted')f.agents=f.agents.slice(1);
    const tree=f.render({deferEffects:true});assert.equal(find(tree,node=>node.type==='Dialog').props.open,false,action);
    staleAdult.props.onClick();assert.equal(f.requests.length,1,action);
    f.agents=old;assert.equal(f.dialog().props.open,false,'reverting data cannot resurrect the old challenge');assert.equal(f.draft.saving,undefined);f.h.dispose();
  }
});

test('Agent Role moderation suppresses late age responses after role refresh or draft replacement', async () => {
  for(const action of ['refresh','draft']) {
    const f=roleModerationFixture();f.submit();
    if(action==='refresh')f.agents[0].data.system_prompt='new backend instructions';
    else f.draft={agentId:'other',overrides:{name:'keep newer draft'}};
    f.render({deferEffects:true});await f.reject(0,'ROLE_AGE_REQUIRED');
    assert.equal(f.dialog().props.open,false,action);assert.equal(f.draft.saving,undefined);
    if(action==='refresh')assert.equal(f.field('agent-role-instructions').props.value,'new backend instructions');
    else assert.equal(f.field('agent-role-name').props.value,'keep newer draft');
    assert.equal(f.requests.length,1);assert.equal(f.writes.length,0);f.h.dispose();
  }
});

test('Agent Role moderation unmount keeps an in-flight draft locked, then clears saving without a stale modal', async () => {
  const f=roleModerationFixture({creating:true}),before=structuredClone(f.draft);f.submit();const unmounted=f.h;
  f.remount();assert.equal(f.draft.saving,true);assert.equal(f.field('agent-role-name').props.disabled,true);
  f.submit();assert.equal(f.requests.length,1,'remounting while a save is pending must not duplicate it');
  await f.reject(0,'ROLE_AGE_REQUIRED');assert.equal(unmounted.updatesAfterDispose,0);assert.deepEqual(f.draft,before);
  assert.equal(f.dialog().props.open,false);assert.equal(f.field('agent-role-name').props.disabled,false);
  await openRoleAgeChallenge(f);const staleAdult=f.button('agentSection.ageAdult');f.remount();
  staleAdult.props.onClick();assert.equal(f.requests.length,2);assert.equal(f.dialog().props.open,false);assert.deepEqual(f.draft,before);f.h.dispose();
  const deferredMount=roleModerationFixture({creating:true}),initial=structuredClone(deferredMount.draft);
  deferredMount.submit({deferEffects:true});deferredMount.h.dispose();await deferredMount.reject(0,'ROLE_AGE_REQUIRED');
  assert.equal(deferredMount.h.updatesAfterDispose,0,'layout cleanup protects an unmount before any passive mount effects');
  assert.deepEqual(deferredMount.draft,initial);assert.equal(deferredMount.requests.length,1);
});

test('Agent Role moderation closing settings never resurrects a draft after an async result', async () => {
  for(const success of [false,true]) {
    const f=roleModerationFixture({creating:true});f.submit();f.h.dispose();f.draft=null;
    if(success)await f.accept(0);else await f.reject(0,'ROLE_AGE_REQUIRED');
    assert.equal(f.draft,null);assert.equal(f.h.updatesAfterDispose,0);assert.equal(f.requests.length,1);
  }
});

test('Agent Role ToCode waits for unresolved session reads but recovers a settled missing session', () => {
  const model={type:'openai_compatible',credential_id:'personal',model:'role-default',parameters:{}};
  let loading=true,fetching=true,error=null,agentId='agent';
  const noop=()=>{},asyncNoop=async()=>{};
  const h=harness({
    'react-router-dom':{useNavigate:()=>noop,useParams:()=>({sessionId:'deleted-session'})},
    '@/hooks/useAgents':{useAgents:()=>({agents:[{id:'agent',editable:true,data:{name:'Ada',chat_model_config:model}}]})},
    '@/hooks/useSessions':{useSessions:()=>({sessions:[],loading,fetching,error,refetch:asyncNoop})},
    '@/hooks/useAvailableModels':{useAvailableModels:()=>({groups:{},loading:false,refetch:noop}),isChatModelAvailable:()=>true},
    '@/hooks/useMessages':{useMessages:()=>({msgs:[],phase:'idle',subagentHitl:[]})},
    '@/hooks/useWorkspace.ts':{useWorkspace:()=>({mcps:[],skills:[]})},
    '@/hooks/useKnowledgeBases':{useKnowledgeBases:()=>({knowledgeBases:[]})},
    '@/hooks/useKnowledgeBaseMiddlewareSchema':{useKnowledgeBaseMiddlewareSchema:()=>({schema:null})},
    '@/hooks/useWorkspaceStatus':{useWorkspaceStatus:()=>({status:null,refetch:asyncNoop})},
    '@/hooks/useToraData':{useToraData:()=>({checkpoints:[],refresh:asyncNoop})},
    '@/lib/projectNaming':{getProjectDisplayName:()=>'',PROJECT_NAMES_CHANGED_EVENT:'project-changed'},
    '@/lib/openPanel':{OPEN_PANEL_EVENT:'tora:open-panel'},'@/utils/authStore':{getToken:()=>null},
  },{localStorage:{getItem:()=>null,setItem(){},removeItem(){}}});
  const {ChatViewport}=h.load('pages/chat/ChatViewport.tsx');const render=()=>h.render(()=>ChatViewport({agentId,sessionId:null}));
  const composer=()=>find(render(),node=>node.type==='ChatContent');
  assert.equal(composer().props.modelControl.props.disabled,true);assert.equal(composer().props.modelControl.props.value,null);
  loading=false;assert.equal(composer().props.sendDisabled,true);
  fetching=false;assert.equal(composer().props.modelControl.props.disabled,false);assert.equal(composer().props.modelControl.props.value,model);assert.equal(composer().props.sendDisabled,false);
  error=Error('offline');assert.equal(composer().props.sendDisabled,true);
  error=null;agentId=null;assert.equal(composer().props.modelControl.props.disabled,true);h.dispose();
});

for (const mode of ['tocode','tochat']) test(`${mode} remembers only successful manual model changes in an existing session`, async () => {
  const model=name=>({type:'openai_compatible',credential_id:'personal',model:name,parameters:{thinkingEffort:'high'}});
  const defaults=model('role-default'),initial=model('draft-choice'),history=model('history'),next=model('next-choice');
  let params={agentId:'agent'},fail=false;
  const view={session:{id:'existing',config:{application_mode:mode,task_mode:'chat',chat_model_config:history},state:{}}};
  const noop=()=>{},asyncNoop=async()=>{};
  const h=harness({
    'react-router-dom':{useNavigate:()=>noop,useParams:()=>params,useSearchParams:()=>[new URLSearchParams()]},
    '@/hooks/useAgents':{useAgents:()=>({agents:[{id:'agent',data:{name:'Ada',chat_model_config:defaults}}]})},
    '@/hooks/useSessions':{useSessions:()=>({sessions:[view],loading:false,fetching:false,error:null,refetch:asyncNoop,update:async(_id,patch)=>{if(fail)throw Error('save failed');view.session.config={...view.session.config,...patch};}})},
    '@/hooks/useMessages':{useMessages:()=>({msgs:[],loading:false,phase:'idle',subagentHitl:[],reloadHistory:asyncNoop})},
    '@/hooks/useWorkspace.ts':{useWorkspace:()=>({mcps:[],skills:[]})},
    '@/hooks/useKnowledgeBases':{useKnowledgeBases:()=>({knowledgeBases:[]})},
    '@/hooks/useKnowledgeBaseMiddlewareSchema':{useKnowledgeBaseMiddlewareSchema:()=>({schema:null})},
    '@/hooks/useWorkspaceStatus':{useWorkspaceStatus:()=>({status:null,refetch:asyncNoop})},
    '@/hooks/useToraData':{useToraData:()=>({checkpoints:[],refresh:asyncNoop})},
    '@/lib/projectNaming':{getProjectDisplayName:()=>'',PROJECT_NAMES_CHANGED_EVENT:'project-changed'},
    '@/lib/openPanel':{OPEN_PANEL_EVENT:'tora:open-panel'},'@/utils/authStore':{getToken:()=>null},
    '@/lib/applicationModes':{modeCopy:()=>key=>key},'framer-motion':{motion:{span:'span'}},
  });
  const Page=mode==='tocode'?h.load('pages/chat/ChatViewport.tsx').ChatViewport:h.load('pages/tochat/index.tsx','\nexport {ToChatConversation};').ToChatConversation;
  const render=()=>h.render(()=>Page({agentId:'agent',sessionId:params.sessionId??null}));
  const composer=()=>find(render(),node=>node.type==='ChatContent');
  await composer().props.modelControl.props.onChange(initial);
  const key=`tora-last-model:${mode==='tocode'?'code-model':'tochat-custom'}`;
  const stored=h.context.localStorage.getItem(key);assert.equal(JSON.parse(stored).model,initial.model);
  params={agentId:'agent',sessionId:'existing'};assert.equal(composer().props.modelControl.props.value,history);
  fail=true;await composer().props.modelControl.props.onChange(next);
  assert.equal(h.context.localStorage.getItem(key),stored,'failed changes never overwrite the preference');
  assert.equal(composer().props.modelControl.props.value,history);
  fail=false;await composer().props.modelControl.props.onChange(next);
  assert.equal(JSON.parse(h.context.localStorage.getItem(key)).model,next.model);
  assert.equal(view.session.config.chat_model_config,next);assert.equal(defaults.model,'role-default');
  params={agentId:'agent'};assert.equal(composer().props.modelControl.props.value.model,next.model,'an old draft does not shadow the latest session choice');
  assert.equal(JSON.stringify(composer().props.modelControl.props.value.parameters),'{}');h.dispose();
});

test('Agent Role ToChat selector opens a new role conversation and retains the task and last chosen model', async () => {
  const model=name=>({type:'openai_compatible',credential_id:'personal',model:name,parameters:{}});
  const a=model('a-default'),b=model('b-default'),manual=model('a-manual'),navigations=[],writes=[];
  let params={agentId:'a'},phase='idle',handlers;
  const h=harness({
    'react-router-dom':{useNavigate:()=>path=>navigations.push(path),useParams:()=>params,useSearchParams:()=>[new URLSearchParams('task=work')]},
    '@/hooks/useAgents':{useAgents:()=>({agents:[{id:'a',data:{name:'Ada',chat_model_config:a}},{id:'b',data:{name:'Lin',chat_model_config:b}}]})},
    '@/hooks/useSessions':{useSessions:()=>({sessions:[],loading:false,refetch:async()=>{},update:async(...args)=>writes.push(args)})},
    '@/hooks/useMessages':{useMessages:(_agent,_session,options)=>{handlers=options;return{msgs:[],loading:false,phase};}},
    '@/lib/applicationModes':{modeCopy:()=>key=>key},'framer-motion':{motion:{span:'span'}},
  });
  const {ToChatConversation}=h.load('pages/tochat/index.tsx','\nexport {ToChatConversation};');
  const render=config=>h.render(ToChatConversation,config);
  const composer=tree=>find(tree,node=>node.type==='ChatContent');
  let tree=render();assert.equal(composer(tree).props.modelControl.props.value,a);
  await composer(tree).props.modelControl.props.onChange(manual);assert.equal(composer(render()).props.modelControl.props.value,manual);
  find(render(),node=>node.type==='AgentSelect').props.onChange('b');
  assert.equal(navigations.at(-1),'/tochat/b?task=work');assert.equal(writes.length,0);
  params={agentId:'b'};tree=render({deferEffects:true});assert.equal(composer(tree).props.modelControl.props.value.model,manual.model);
  assert.equal(handlers.newSessionExtras().chat_model_config.model,manual.model);
  phase='streaming';render();handlers.onSessionCreated('fresh-b');params={agentId:'b',sessionId:'fresh-b'};
  tree=render();assert.equal(composer(tree).props.modelControl.props.value.model,manual.model);
  assert.equal(find(tree,node=>node.type==='AgentSelect').props.disabled,true);
  h.dispose();
});

test('Harness TaskCreate renderer uses current and historical task ids', () => {
  const h=harness({'./_shared':{getResultText:value=>value?.text??'',parseInput:JSON.parse,toolArgClass:'args',toolLabelClass:'label'},'@/lib/toolDisplayName':{getToolDisplayName:()=> 'Create task'}});
  const {TaskCreateRenderer}=h.load('components/chat/tool-renderers/TaskCreateRenderer.tsx');
  const render=text=>TaskCreateRenderer.renderHeader({call:{name:'TaskCreate',input:'{"subject":"回归测试"}'},result:{text}},key=>key);
  const badge=text=>find(render(text),node=>node.type==='span'&&node.props.className?.includes('font-mono'));
  assert.equal(badge('已创建 #T12：回归测试（共 12 条任务）。').props.children.join(''),'#T12 ');
  assert.equal(badge('Task (id=3) created successfully: regression').props.children.join(''),'#3 ');
  assert.equal(badge('TaskCreate 需要 subject。'),null);h.dispose();
});

test('workspace stage exposes wallpaper without making composer cards transparent', () => {
  const css = readFileSync(new URL('index.css', base), 'utf8');
  const stageRules = css.match(/(?:\.dark\s+)?\.app-stage\s*\{[^}]*\}/g) || [];
  assert.ok(stageRules.length > 0);
  for (const rule of stageRules) {
    assert.match(rule, /background\s*:\s*transparent\s*;/);
    assert.doesNotMatch(rule, /box-shadow\s*:|border-radius\s*:/);
  }
  const composer = readFileSync(new URL('components/chat/TextInput.tsx', base), 'utf8');
  assert.match(composer, /composer-shell[^'\n]*\bbg-card\b/);
});

test('hot UI checkpoint preserves a real composer draft, refuses busy/files/forms, and isolates route and account',()=>{
 const storage=new Map(),listeners=new Map();let owner='fixture-one',blockedForm=false;
 const window={location:{pathname:'/tochat/agent',search:'?task=work'},toraAuth:{getEmail:()=>owner},addEventListener:(name,cb)=>{if(!listeners.has(name))listeners.set(name,new Set());listeners.get(name).add(cb);},removeEventListener:(name,cb)=>listeners.get(name)?.delete(cb),dispatchEvent:event=>{for(const cb of listeners.get(event.type)||[])cb(event);}};
 const document={querySelector:()=>blockedForm?{}:null,querySelectorAll:selector=>selector==='input,textarea'?[]:[{scrollTop:42}]};
 const h=harness({}, {window,document,sessionStorage:{getItem:key=>storage.get(key)||null,setItem:(key,value)=>storage.set(key,value)},CustomEvent:class{constructor(type,{detail}){this.type=type;this.detail=detail;}}});
 const state=h.load('lib/uiCheckpoint.ts');h.mock('@/lib/uiCheckpoint',state);
 const{TextInput}=h.load('components/chat/TextInput.tsx');let phase='idle';
 const render=()=>h.render(()=>TextInput({phase,onSend(){}},null));
 find(render(),node=>node.type==='textarea').props.onChange({target:{value:'热更新不能丢草稿'}});render();
 assert.equal(state.captureUICheckpoint(),true);assert.equal(state.restoreUIState('draft-text',''),'热更新不能丢草稿');
 find(render(),node=>node.type==='textarea').props.onChange({target:{value:''}});render();assert.equal(state.restoreUIState('draft-text','fallback'),'');
 find(render(),node=>node.type==='textarea').props.onChange({target:{value:'新草稿'}});render();assert.equal(state.restoreUIState('draft-text','fallback'),'新草稿');
 phase='streaming';render();assert.equal(state.captureUICheckpoint(),false);
 phase='idle';render();blockedForm=true;assert.equal(state.captureUICheckpoint(),false);blockedForm=false;
 owner='fixture-two';assert.equal(state.restoreUIState('draft-text','fallback'),'fallback');owner='fixture-one';window.location.pathname='/tochat/other';assert.equal(state.restoreUIState('draft-text','fallback'),'fallback');
 h.dispose();
});

test('迟到的旧账号模型响应不覆盖当前账号；镜像 PUT 按顺序完成', async () => {
  let token = 'A'; const a = deferred(), writes = [], firstWrite = deferred();
  let blockWrite = false;
  const h = harness({ './authStore': { getToken: () => token } }, { fetch: async (url, init) => {
    if (url.endsWith('/admin/tochat-config')) return Response.json({});
    if (url.endsWith('/models')) return init.headers.authorization === 'Bearer A' ? a.promise : Response.json({ models: [{ apiKey: token }] });
    if (blockWrite && JSON.parse(init.body).models[0].apiKey === 'B') await firstWrite.promise;
    writes.push(JSON.parse(init.body).models[0].apiKey); return Response.json({});
  } });
  const model = h.load('utils/modelSync.ts');
  const old = model.syncModelsFromCloud(); token = 'B'; await model.syncModelsFromCloud();
  a.resolve(Response.json({ models: [{ apiKey: 'A' }] })); await old;
  assert.deepEqual(writes, ['B']);
  blockWrite = true;
  const oldWrite = model.syncLocalModelMirror([{ apiKey: 'B' }], 'B'); await tick();
  token = 'C'; const currentWrite = model.syncLocalModelMirror([{ apiKey: 'C' }], 'C');
  firstWrite.resolve(); await Promise.all([oldWrite, currentWrite]);
  assert.deepEqual(writes, ['B', 'B', 'C']);
});

test('非 JSON 401 保留凭据；确认的 JSON 401 才退出', async () => {
  for (const type of ['text/html', 'application/json']) {
    let cleared = 0;
    const h = harness({ '@/utils/authStore': { getToken: () => 'account', clearAll: async () => { cleared++; } },
      '@/utils/modelSync': { cloudFetch: async () => new Response('', { status: 401, headers: { 'content-type': type } }), cloudApi: () => 'https://fixture.invalid' } });
    const { AccountPresence } = h.load('components/auth/AccountPresence.tsx');
    h.render(() => AccountPresence({ children: null })); await tick(); h.dispose();
    assert.equal(cleared > 0, type === 'application/json');
  }
});

test('同名图片分别回写自己的处理结果，失败不删除其它同名附件', async () => {
  const a = deferred(), b = deferred(), sent = [];
  const h = harness(); const { TextInput } = h.load('components/chat/TextInput.tsx');
  const props = { onSend: blocks => sent.push(blocks), fileProcessor: file => file.which === 'A' ? a.promise : b.promise, allowedInputTypes: ['image'] };
  const render = () => h.render(() => TextInput(props, null)); let tree = render();
  find(tree, node => node.type === 'input' && node.props.type === 'file').props.onChange({ target: { files: [{ name: 'image.png', which: 'A' }, { name: 'image.png', which: 'B' }], value: 'files' } });
  a.resolve({ id: 'A', type: 'text', text: 'content-A' }); await tick();
  b.resolve({ id: 'B', type: 'text', text: 'content-B' }); await tick();
  tree = render(); find(tree, node => node.type === 'textarea').props.onChange({ target: { value: 'Compare images' } }); tree = render();
  find(tree, node => node.type === 'Button' && node.props['aria-label'] === 'textInput.send').props.onClick();
  assert.deepEqual(Array.from(sent[0].slice(1), block => block.id), ['A', 'B']); h.dispose();
});

function messagesFixture(language = 'zh') {
  const creating = deferred(), history = deferred(), navigations = [], triggers = [], fresh = new Set();
  let agentId = 'agent', sessionId = null, delayedHistory = false;
  const options = { onSessionCreated: id => navigations.push(id) };
  const preference={language},created=[];
  const h = harness({ '@/i18n': {__esModule:true,default:preference}, '@/api': {
    takeFreshlyCreated: id => fresh.delete(id),
    sessionApi: { create: body => {created.push(body);return creating.promise.then(res => { fresh.add(res.session_id); return res; });},
      messages: async id => delayedHistory && id === 'A' ? history.promise : { messages: [{ id: id + '-user', role: 'user', content: [] }], is_running: false },
      async *stream() {} },
    chatApi: { trigger: async value => { triggers.push(value); } },
  } });
  const { useMessages } = h.load('hooks/useMessages.ts');
  const render = () => h.render(() => useMessages(agentId, sessionId, options));
  return { h, render, creating, history, navigations, triggers, created, preference,
    setSession(id) { sessionId = id; }, delayHistory() { delayedHistory = true; } };
}

test('desktop first-send naming captures the selected language before session creation completes',async()=>{
 for(const language of ['en-GB','fr','ja','zh-HK']){
  const f=messagesFixture(language);const sending=f.render().send([{type:'text',text:'Fix the keyboard layout'}]);
  f.preference.language='zh';assert.equal(f.created[0].title_language,language);
  f.creating.resolve({session_id:'localized-title'});await sending;f.h.dispose();
 }
});

test('首发建会话迟到时不跳离当前会话，任务仍发送到原会话', async () => {
  const f = messagesFixture(); const first = f.render();
  const sending = first.send([{ type: 'text', text: 'original task' }]);
  f.setSession('B'); f.render(); await tick();
  f.creating.resolve({ session_id: 'C' }); await sending; await tick();
  assert.equal(f.navigations.length, 0);
  assert.deepEqual(Array.from(f.render().msgs, m => m.id), ['B-user']);
  assert.equal(f.triggers[0].session_id, 'C');
  f.h.dispose();
});

test('重新读取历史的迟到响应不能把 A 的系统消息加入 B', async () => {
  const f = messagesFixture(); f.setSession('A'); f.render(); await tick();
  const a = f.render(); f.delayHistory(); const reload = a.reloadHistory();
  f.setSession('B'); f.render();
  f.history.resolve({ messages: [{ id: 'A-system', role: 'system', content: [] }], is_running: false });
  await reload; await tick();
  assert.deepEqual(Array.from(f.render().msgs, message => message.id), ['B-user']);
  f.h.dispose();
});

test('ToChat 自定义模型未选择时输入框禁用发送，草稿不被清空', () => {
  const h = harness({
    'react-router-dom': { useNavigate: () => () => {}, useParams: () => ({ agentId: 'agent' }), useSearchParams: () => [new URLSearchParams()] },
    '@/hooks/useAgents': { useAgents: () => ({ agents: [{ id: 'agent', data: { name: 'Covey' } }] }) },
    '@/hooks/useSessions': { useSessions: () => ({ sessions: [], loading: false, refetch() {} }) },
    '@/hooks/useMessages': { useMessages: () => ({ msgs: [], loading: false, phase: 'idle', send() { throw Error('Must not send'); } }) },
    '@/hooks/useMotionSettings': { useMotionSettings: () => ({ effective: 'off', clickEnabled: false }) },
    '@/lib/applicationModes': { readToChatSource: () => 'custom', modeCopy: () => key => key },
    '@/utils/authStore': { getToken: () => '' },
    'framer-motion': { motion: { span: 'span' } },
  });
  const { ToChatConversation } = h.load('pages/tochat/index.tsx', '\nexport { ToChatConversation };');
  const tree = h.render(() => ToChatConversation());
  const composer = find(tree, node => node.type === 'ChatContent');
  assert.equal(composer.props.disabled, true); h.dispose();
  const editor = harness();
  const { TextInput } = editor.load('components/chat/TextInput.tsx');
  const render = () => editor.render(() => TextInput({ disabled: composer.props.disabled, fileProcessor: async () => null, onSend() { throw Error('Draft must not be submitted'); } }, null));
  find(render(), node => node.type === 'textarea').props.onChange({ target: { value: 'keep this draft' } });
  const field = find(render(), node => node.type === 'textarea');
  field.props.onKeyDown({ key: 'Enter', shiftKey: false, nativeEvent: {}, preventDefault() {} });
  assert.equal(find(render(), node => node.type === 'textarea').props.value, 'keep this draft');
  editor.dispose();
});


test('同一轮中被进度文字拆开的工具汇总一次，保留结果、顺序和结语', () => {
  const h = harness();
  const { groupToolCalls, splitAssistantContent } = h.load('components/chat/ASMessageBubble.tsx', '\nexport { groupToolCalls, splitAssistantContent };');
  const call = (id, name) => ({ type: 'tool_call', id, name });
  const result = (id, state) => ({ type: 'tool_result', id, state, output: id });
  const input = [{type:'text',text:'开始检查'},call('a','Read'),call('b','Grep'),result('b','error'),result('a','success'),{type:'text',text:'继续验证'},call('c','Bash'),{type:'thinking',thinking:'分析'},result('c','denied'),{type:'text',text:'最终结语'}];
  const {processBlocks,finalBlocks} = splitAssistantContent(groupToolCalls(input));
  const groups = processBlocks.filter(block => block.type === 'tool_call_group');
  assert.equal(groups.length,1);
  assert.deepEqual(Array.from(groups[0].calls,pair=>[pair.call.id,pair.result.state]),[['a','success'],['b','error'],['c','denied']]);
  assert.deepEqual(Array.from(finalBlocks,block=>block.text),['最终结语']);
  assert.deepEqual(Array.from(processBlocks.filter(block=>block.type==='text'),block=>block.text),['开始检查','继续验证']);
  const {groupToolState} = h.load('components/chat/tool-renderers/_shared.tsx');
  assert.equal(groupToolState(groups[0].calls),'error');
  assert.equal(groupToolState([...groups[0].calls,{call:call('d','Read')}]),undefined);
  assert.equal(groupToolState([{call:call('e','Read'),result:result('e','denied')}]),'interrupted');
});

test('首发建会话后路由与侧栏选择对应会话，ToCode/ToChat 新建入口均取消高亮', async () => {
  const f = messagesFixture();
  const sending = f.render().send([{type:'text',text:'新任务'}]);
  f.creating.resolve({session_id:'new-session'}); await sending; await tick();
  assert.deepEqual(f.navigations,['new-session']); f.h.dispose();
  for (const mode of ['chat','tochat']) {
    let pathname = '/' + mode + '/agent';
    const mocks = {
      'date-fns':{format:()=> '2026-10-03'},
      'react-router-dom': {useNavigate:()=>()=>{},useLocation:()=>({pathname,search:''})},
      '@/components/auth/AccountPresence':{useAccountPresence:()=>({unread:0})},
      '@/hooks/useMacFullscreen':{useMacFullscreen:()=>false},
      '@/utils/authStore':{getUsername:()=> 'fixture',getEmail:()=>'',getToken:()=>''},
      '@/utils/modelSync':{cloudFetch:async()=>Response.json({}),cloudApi:()=>''},
      '@/hooks/useAgents':{useAgents:()=>({agents:[{id:'agent',data:{name:'Covey'}}]})},
      '@/hooks/useSessions':{useSessions:()=>({sessions:[{session:{id:'new-session',title:'新任务会话',updated_at:'2026-10-03',origin:{type:'user'},config:{application_mode:mode==='tochat'?'tochat':'tocode'}}}],refetch(){},update(){},remove(){}})},
      '@/lib/projectNaming':{projectKey:()=>null},
    };
    const h = harness(mocks);
    const {AppSidebar} = h.load('components/layout/AppSidebar.tsx');
    assert.equal(find(h.render(()=>AppSidebar()),node=>node.props?.['data-testid']==='new-conversation').props.isActive,true);
    pathname += '/new-session';
    assert.equal(find(h.render(()=>AppSidebar()),node=>node.props?.['data-testid']==='new-conversation').props.isActive,false);
    const list = harness(mocks);
    const {SessionListSection} = list.load('components/layout/SessionListSection.tsx');
    assert.equal(find(list.render(()=>SessionListSection()),node=>node.type==='SidebarMenuButton' && node.props.isActive).props.isActive,true);
    h.dispose(); list.dispose();
  }
});

test('新任务同步进入空白页；从旧会话、空白页和其它页面点击均不提前建会话', async () => {
  for (const [pathname, search, expected] of [
    ['/chat/agent/old-session', '', '/chat/agent'],
    ['/chat/agent', '', '/chat/agent'],
    ['/schedule', '', '/chat?new=1'],
    ['/chat', '', '/chat?new=1'],
    ['/tochat/agent/old-session', '?task=work', '/tochat/agent?task=work'],
  ]) {
    const navigations = []; let creates = 0;
    const h = harness({
      'react-router-dom':{useLocation:()=>({pathname,search}),useNavigate:()=>path=>navigations.push(path)},
      '@/components/auth/AccountPresence':{useAccountPresence:()=>({unread:0})},
      '@/hooks/useMacFullscreen':{useMacFullscreen:()=>false},
      '@/utils/authStore':{getUsername:()=> 'fixture',getEmail:()=>'',getToken:()=>''},
      '@/utils/modelSync':{cloudFetch:async()=>Response.json({})},
      '@/api':{agentApi:{list:async()=>({agents:[{id:'agent'}]})},sessionApi:{create:async()=>{creates++;return {session_id:'unwanted-empty-session'};}}},
    },{localStorage:{getItem:key=>({chat_last_agent:'agent',chat_last_session:'old-session'})[key]??null}});
    const {AppSidebar} = h.load('components/layout/AppSidebar.tsx');
    const tree = h.render(()=>AppSidebar());
    find(tree,node=>node.props?.['data-testid']==='new-conversation').props.onClick();
    assert.deepEqual(navigations,[expected],pathname+' 应立即进入空白任务路由');
    await tick(); assert.equal(creates,0,'创建会话应等首次发送'); h.dispose();
  }
});

test('显式新任务入口跳过旧会话恢复，普通启动仍恢复；新任务首发导航到新会话', () => {
  for (const [search, expected] of [['?new=1','/chat/agent'],['','/chat/agent/old-session']]) {
    const navigations = []; let params = {};
    const storage = new Map([['chat_last_agent','agent'],['chat_last_session','old-session']]);
    const h = harness({
      'react-router-dom':{useNavigate:()=>path=>navigations.push(path),useParams:()=>params,useSearchParams:()=>[new URLSearchParams(search)]},
      '@/hooks/useAgents':{useAgents:()=>({agents:[{id:'agent',data:{name:'Covey'}}]})},
      '@/hooks/useSessions':{useSessions:()=>({sessions:[],refetch(){}})},
      '@/api/session':{hasFreshlyCreated:()=>false},
    },{localStorage:{getItem:key=>storage.get(key)??null,setItem:(key,value)=>storage.set(key,value),removeItem:key=>storage.delete(key)}});
    const {ChatPageInner} = h.load('pages/chat/index.tsx','\nexport { ChatPageInner };');
    h.render(()=>ChatPageInner()); assert.deepEqual(navigations,[expected]);
    if(search) {
      params = {agentId:'agent'};
      const tree=h.render(()=>ChatPageInner());
      const viewport=find(tree,node=>node.type==='ChatViewport');
      assert.equal(viewport.props.sessionId,null,'空白页不能显示上次会话');
      viewport.props.onSessionCreated('new-session');
      assert.equal(navigations.at(-1),'/chat/agent/new-session');
      assert.equal(storage.get('chat_last_session'),'old-session','新建入口不删除已有会话记忆');
    }
    h.dispose();
  }
});

test('ToChat 工作任务运行中权限选择保持可用并提交修改',async()=>{
  const writes=[];
  const h=harness({
    'react-router-dom':{useNavigate:()=>()=>{},useParams:()=>({agentId:'agent',sessionId:'session'}),useSearchParams:()=>[new URLSearchParams('task=work')]},
    '@/hooks/useAgents':{useAgents:()=>({agents:[{id:'agent',data:{name:'Covey'}}]})},
    '@/hooks/useSessions':{useSessions:()=>({sessions:[{session:{id:'session',state:{permission_context:{mode:'default'}},config:{application_mode:'tochat',task_mode:'work',model_source:'custom',chat_model_config:{model:'fixture'}}}}],loading:false,refetch:async()=>{},update:async(id,patch)=>writes.push([id,'agent',patch])})},
    '@/hooks/useMessages':{useMessages:()=>({msgs:[],loading:false,phase:'streaming'})},
    '@/hooks/useMotionSettings':{useMotionSettings:()=>({effective:'off',clickEnabled:false})},
    '@/lib/applicationModes':{readToChatSource:()=> 'custom',modeCopy:()=>key=>key},
    '@/utils/authStore':{getToken:()=>''},
    '@/api':{sessionApi:{update:async(...args)=>writes.push(args)}},
    'framer-motion':{motion:{span:'span'}},
  });
  const {ToChatConversation}=h.load('pages/tochat/index.tsx','\nexport {ToChatConversation};');
  const tree=h.render(()=>ToChatConversation());
  const control=find(tree,node=>node.type==='ChatContent').props.permissionControl;
  assert.equal(control.props.disabled,false);
  await control.props.onChange('bypass');
  assert.equal(writes.length,1);assert.equal(writes[0][2].permission_mode,'bypass');h.dispose();
});

test('web first send immediately after a new draft never reuses the previous conversation before passive effects', {skip: !existsSync(new URL('../website/tochat/src/useWebConversation.ts',import.meta.url))},async()=>{
 const oldUser={id:'old-user',role:'user',content:[{type:'text',text:'old message'}],finished_at:'old'};
 let active={id:'old-conversation',owner:'fixture',title:'old',mode:'chat',effort:'high',messages:[oldUser],wire:[{role:'user',content:'old message'}]},sent=[],saved=[];
 const h=harness({
  '@agentscope-ai/agentscope/event':{ReplyFinishedReason:{COMPLETED:'completed',ERROR:'error'}},
  './i18n.ts':{webText:value=>value},'./api':{webFetch:async(_path,init)=>{sent.push(JSON.parse(init.body));return {};},webJSON:async()=>({title:null})},
  './storage':{saveConversation:async value=>saved.push(structuredClone(value)),applyConversationTitle:async()=>null},
  './stream':{readChatStream:async()=>({content:'new reply',reasoning:'',tools:[]})},
 },{structuredClone});
 const{useWebConversation}=h.load('../../../../website/tochat/src/useWebConversation.ts');
 const options={mode:'chat',model:'deepseek-flash',effort:'high',search:false,confirmWrites:true,onUpdate:value=>{active=value;},onQuota(){}};
 const render=(config)=>h.render(()=>useWebConversation('fixture',active,options),config);
 render();render();active=null;render({deferEffects:true});
 const task=render({deferEffects:true}).send([{type:'text',text:'first new message'}]);await task;h.flushEffects();
 assert.notEqual(active.id,'old-conversation','fresh draft must create its own conversation');
 assert.deepEqual(sent[0].messages.map(message=>message.content),[[{type:'text',text:'first new message'}]],'first request must contain only its own user message');
 assert.equal(saved.at(-1).messages.filter(message=>message.role==='user').length,1);
 assert.equal(render().msgs[0].content[0].text,'first new message');h.dispose();
});

test('web fast first reply survives a delayed initial draft effect', {skip: !existsSync(new URL('../website/tochat/src/useWebConversation.ts',import.meta.url))},async()=>{
 let active=null;
 const h=harness({
  '@agentscope-ai/agentscope/event':{ReplyFinishedReason:{COMPLETED:'completed',ERROR:'error'}},
  './i18n.ts':{webText:value=>value},'./api':{webFetch:async()=>({}),webJSON:async()=>({title:null})},
  './storage':{saveConversation:async()=>{},applyConversationTitle:async()=>null},
  './stream':{readChatStream:async()=>({content:'instant reply',reasoning:'',tools:[]})},
 },{structuredClone});
 const{useWebConversation}=h.load('../../../../website/tochat/src/useWebConversation.ts');
 const options={mode:'chat',model:'deepseek-flash',effort:'high',search:false,confirmWrites:true,onUpdate:value=>{active=value;},onQuota(){}};
 const render=(config)=>h.render(()=>useWebConversation('fixture',active,options),config);
 await render({deferEffects:true}).send([{type:'text',text:'visible first message'}]);h.flushEffects();
 assert.equal(render({deferEffects:true}).msgs[0]?.content[0]?.text,'visible first message','a late draft effect must not clear a completed first turn');
 h.flushEffects();h.dispose();
});

test('网页工作中切为允许修改会恢复待审批并让同轮后续调用使用新模式', {skip: !existsSync(new URL('../website/tochat/src/useWebConversation.ts',import.meta.url))}, async()=>{
  let round=0,approved=0,opts={mode:'work',effort:'high',search:false,confirmWrites:true,onUpdate(){},onQuota(){}};
  const h=harness({
    '@agentscope-ai/agentscope/event':{ReplyFinishedReason:{COMPLETED:'completed',INTERRUPTED:'interrupted',ERROR:'error',EXCEED_MAX_ITERS:'exceed_max_iters'}},
    './i18n.ts':{webText:value=>value},
    './api':{webFetch:async()=>({})},
    './storage':{saveConversation:async()=>{}},
    './stream':{readChatStream:async()=>({content:'done',reasoning:'',tools:++round===1?['a','b'].map(id=>({id,function:{name:'Write',arguments:'{}'}})):[]})},
    './localFiles':{selectedDirectory:()=>({}),localToolDefinitions:[{function:{name:'Write'}}],executeLocalTool:async(_name,_args,confirm)=>{if(await confirm())approved++;return {ok:true};}},
  },{structuredClone});
  const {useWebConversation}=h.load('../../../../website/tochat/src/useWebConversation.ts');
  const render=()=>h.render(()=>useWebConversation('fixture',null,opts));
  const sending=render().send([{type:'text',text:'work'}]);await tick();assert.equal(approved,0);
  opts={...opts,confirmWrites:false};render();await sending;
  assert.equal(approved,2,'待审批和后续修改均使用最新设置');h.dispose();
});

test('网页工作中重新启用确认会阻止尚未开始的写入', {skip: !existsSync(new URL('../website/tochat/src/useWebConversation.ts',import.meta.url))}, async()=>{
  let round=0,release,approved=0,opts={mode:'work',effort:'high',search:false,confirmWrites:false,onUpdate(){},onQuota(){}};
  const h=harness({
    '@agentscope-ai/agentscope/event':{ReplyFinishedReason:{COMPLETED:'completed',ERROR:'error'}},
    './i18n.ts':{webText:value=>value},'./api':{webFetch:async()=>({})},'./storage':{saveConversation:async()=>{}},
    './stream':{readChatStream:()=>++round===1?new Promise(resolve=>{release=()=>resolve({content:'',tools:[{id:'write',function:{name:'Write',arguments:'{}'}}]});}):{content:'done',tools:[]}},
    './localFiles':{selectedDirectory:()=>({}),localToolDefinitions:[{function:{name:'Write'}}],executeLocalTool:async(_name,_args,confirm)=>{if(await confirm())approved++;return {ok:true};}},
  },{structuredClone});
  const {useWebConversation}=h.load('../../../../website/tochat/src/useWebConversation.ts');
  const render=()=>h.render(()=>useWebConversation('fixture',null,opts));
  const sending=render().send([{type:'text',text:'work'}]);await tick();
  opts={...opts,confirmWrites:true};render();release();await tick();
  assert.equal(approved,0,'新模式要求确认，未作答前不写入');
  await render().onUserConfirm({},true);await sending;assert.equal(approved,1);h.dispose();
});

test('ToChat 自配模型保留草稿；旧官方会话必须显式选择，不能误用草稿配置',async()=>{
 let params={agentId:'agent'},extras;const writes=[];
 const custom={type:'openai_compatible',credential_id:'custom-key',model:'deepseek-chat-custom',parameters:{thinkingEffort:'medium'}};
 const sessions=[{session:{id:'legacy',state:{},config:{application_mode:'tochat',model_source:'official',chat_model_config:{credential_id:'tora-official',model:'deepseek-flash'}}}}];
 const h=harness({
  'react-router-dom':{useNavigate:()=>()=>{},useParams:()=>params,useSearchParams:()=>[new URLSearchParams()]},
  '@/hooks/useAgents':{useAgents:()=>({agents:[{id:'agent',data:{name:'Covey'}}]})},
  '@/hooks/useSessions':{useSessions:()=>({sessions,loading:false,refetch:async()=>{},update:async(id,patch)=>{writes.push({id,patch});sessions[0].session.config={...sessions[0].session.config,...patch};}})},
  '@/hooks/useMessages':{useMessages:(_a,_s,options)=>{extras=options.newSessionExtras;return {msgs:[],loading:false,phase:'idle'};}},
  '@/api':{sessionApi:{update:async(id,_agent,patch)=>{writes.push({id,patch});sessions[0].session.config={...sessions[0].session.config,...patch};}}},
  '@/lib/applicationModes':{modeCopy:()=>key=>key},'framer-motion':{motion:{span:'span'}},
 });
 const {ToChatConversation}=h.load('pages/tochat/index.tsx','\nexport {ToChatConversation};');const render=()=>h.render(()=>ToChatConversation());
 const composer=()=>find(render(),node=>node.type==='ChatContent');
 assert.equal(composer().props.sendDisabled,true);await composer().props.modelControl.props.onChange(custom);
 assert.equal(composer().props.sendDisabled,false);assert.equal(extras().chat_model_config.model,'deepseek-chat-custom');
 params={agentId:'agent',sessionId:'legacy'};let ui=composer();assert.equal(ui.props.modelControl.props.value.model,'deepseek-flash');assert.equal(ui.props.sendDisabled,true);assert.notEqual(ui.props.modelControl.props.includeBuiltin,true);
 await ui.props.modelControl.props.onChange(custom);ui=composer();assert.equal(writes.length,1);assert.equal(writes[0].patch.chat_model_config.model,'deepseek-chat-custom');assert.equal(ui.props.modelControl.props.value.parameters.thinkingEffort,'medium');assert.equal(ui.props.sendDisabled,false);
 params={agentId:'agent',sessionId:'missing'};assert.equal(composer().props.modelControl.props.value,null);
 params={agentId:'agent'};assert.equal(composer().props.modelControl.props.value.model,'deepseek-chat-custom');h.dispose();
});

test('自定义 Gemini 保存 medium 后选择器仍显示 medium',()=>{
 const h=harness();const {thinkingLevelOf}=h.load('components/select/LlmSelect.tsx','\nexport {thinkingLevelOf};');
 assert.equal(thinkingLevelOf({thinking:true,thinkingEffort:'medium'},{parameter_schema:{properties:{thinkingEffort:{enum:['low','medium','high']}}}}),'medium');h.dispose();
});

test('网页 Gemini medium 随新对话保存并按原值发送', {skip: !existsSync(new URL('../website/tochat/src/useWebConversation.ts',import.meta.url))}, async()=>{
 const sent=[],saved=[];
 const h=harness({
  '@agentscope-ai/agentscope/event':{ReplyFinishedReason:{COMPLETED:'completed',ERROR:'error'}},
  './i18n.ts':{webText:value=>value},'./api':{webFetch:async(_path,init)=>{sent.push(JSON.parse(init.body));return {}; }},
  './storage':{saveConversation:async value=>saved.push(structuredClone(value))},
  './stream':{readChatStream:async()=>({content:'OK',reasoning:'',tools:[]})},
 },{structuredClone});
 const {useWebConversation}=h.load('../../../../website/tochat/src/useWebConversation.ts');
 const options={mode:'chat',model:'gemini-3.8-flash',effort:'medium',search:false,confirmWrites:true,onUpdate(){},onQuota(){}};
 await h.render(()=>useWebConversation('fixture',null,options)).send([{type:'text',text:'hello'}]);
 assert.equal(sent[0].reasoning_effort,'medium');assert.equal(saved.at(-1).model,'gemini-3.8-flash');assert.equal(saved.at(-1).effort,'medium');h.dispose();
});

test('built-in account sync serializes token changes and clears the local runtime on sign-out',async()=>{
 let token='A';const first=deferred(),writes=[];const h=harness({'./authStore':{getToken:()=>token}},{fetch:async(url,init)=>{assert.ok(url.endsWith('/admin/tochat-config'));const value=JSON.parse(init.body).authToken;if(value==='A')await first.promise;writes.push(value);return Response.json({});}});
 const {syncBuiltinModelAuth}=h.load('utils/modelSync.ts');const old=syncBuiltinModelAuth();await tick();token='B';const current=syncBuiltinModelAuth();first.resolve();await Promise.all([old,current]);assert.deepEqual(writes,['A','B']);token='';await syncBuiltinModelAuth();assert.equal(writes.at(-1),'');
});

test('ToCode picker hides built-in models and keeps custom models',()=>{
 const h=harness({'@/hooks/useAvailableModels':{useAvailableModels:()=>({groups:{tora_official:[{credential:{id:'tora-official',data:{type:'tora_official',source:'builtin-models',name:'Tora'}},models:[{name:'gpt-6.1-sol',input_types:['text','image/png'],context_size:300000}]}],openai_compatible:[{credential:{id:'cocode-models',data:{type:'openai_compatible',name:'Tora 模型'}},models:[{name:'own-model',input_types:['text'],context_size:128000}]}]},loading:false,refetch(){},builtinQuota:null,builtinUnavailable:false})},'@/utils/common':{credentialLabel:()=>'Tora 模型'}});
 const {LlmSelect}=h.load('components/select/LlmSelect.tsx');
 const tree=h.render(()=>LlmSelect({value:{type:'openai_compatible',credential_id:'cocode-models',model:'own-model',parameters:{thinking:true,thinkingEffort:'high'}}}));
 assert.equal(find(tree,node=>node.type==='span'&&node.props.children==='GPT-6.1 Sol'),null);
 assert.ok(find(tree,node=>node.type==='span'&&node.props.children==='own-model'));
 const builtinOnly=harness({'@/hooks/useAvailableModels':{useAvailableModels:()=>({groups:{tora_official:[{credential:{id:'tora-official',data:{type:'tora_official'}},models:[{name:'gpt-6.1-sol',input_types:['text'],context_size:300000}]}]},loading:false,refetch(){},builtinQuota:null,builtinUnavailable:false})}});
 const {LlmSelect:HiddenSelect}=builtinOnly.load('components/select/LlmSelect.tsx');
 const hidden=builtinOnly.render(()=>HiddenSelect({value:{type:'tora_official',credential_id:'tora-official',model:'gpt-6.1-sol',parameters:{}}}));
 assert.equal(find(hidden,node=>node.type?.name==='SubmenuRow'),null);
 assert.ok(find(hidden,node=>node.type==='p'&&node.props.children==='llm-select.empty.description'));
 h.dispose();builtinOnly.dispose();
});

test('model groups expose only available built-ins and keep personal credentials usable during quota outages',async()=>{
 let online=true;const quota={enabled:true,models:[{id:'deepseek-flash',enabled:true},{id:'gemini-3.8-flash',enabled:true},{id:'gpt-6.1-sol',enabled:false}],remainingPercent: 100, canUseAgent: true, subscription: {planId:'plus',name:'Tora Plus',expiresAt:'2099-01-01T00:00:00Z'}, windows: [{key:'fiveHour',remainingPercent:100,resetAt:null}], workDailyRemaining:1000000,workWeeklyRemaining:10000000};
 const h=harness({'@/api':{credentialApi:{list:async()=>({credentials:[{id:'personal',data:{type:'openai_compatible'}},{id:'tora-official',data:{type:'tora_official'}}]})},modelApi:{list:async type=>({models:(type==='tora_official'?['gpt-6.1-sol','gemini-3.8-flash','deepseek-flash']:['own-model']).map(name=>({name}))})}},'@/utils/modelSync':{syncBuiltinModelAuth:async()=>{},fetchBuiltinQuota:async()=>online?Response.json(quota):Response.json({detail:'unavailable'},{status:503})}});
 const {fetchGroups,modelGroupsWithQuota}=h.load('hooks/useAvailableModels.ts','\nexport {fetchGroups};');let groups=modelGroupsWithQuota(await fetchGroups(),quota,false);assert.deepEqual(Array.from(groups.tora_official[0].models,model=>model.name),['deepseek-flash','gemini-3.8-flash']);assert.equal(groups.openai_compatible[0].models[0].name,'own-model');
 online=false;groups=await fetchGroups();assert.equal(groups.tora_official[0].models.length,3,'a quota outage must retain the known model catalog');assert.equal(groups.tora_official[0].unavailable,true);assert.equal(groups.openai_compatible[0].models[0].name,'own-model');const recovered=modelGroupsWithQuota(groups,quota,false);assert.deepEqual(Array.from(recovered.tora_official[0].models,m=>m.name),['deepseek-flash','gemini-3.8-flash']);assert.equal(recovered.tora_official[0].unavailable,false);h.dispose();
});

test('ToCode shows a retry and keeps the known catalog disabled during an outage; healthy opens use the cache',()=>{
 for(const unavailable of [true,false]){
  let reloads=0;
  const h=harness({'@/hooks/useAvailableModels':{useAvailableModels:()=>({groups:{tora_official:[{credential:{id:'tora-official',data:{type:'tora_official'}},models:[{name:'gpt-6-sol'}]}]},loading:false,builtinQuota:{enabled:true,models:[{id:'gpt-6-sol',enabled:true,allowed:true}]},builtinUnavailable:unavailable,refetch(){reloads++;}})}},{document:{visibilityState:'visible',addEventListener(){},removeEventListener(){}}});
  const{LlmSelect}=h.load('components/select/LlmSelect.tsx');let tree=h.render(()=>LlmSelect({}));
  find(tree,node=>node.type==='Popover').props.onOpenChange(true);assert.equal(reloads,unavailable?1:0,'opening a healthy menu must not add network traffic');
  tree=h.render(()=>LlmSelect({}));assert.equal(find(tree,node=>node.type==='button'&&find(node,child=>child.type==='span'&&child.props.children==='GPT-6 Sol')),null);
  const retry=find(tree,node=>node.type==='button'&&node.props.children==='error.retry');assert.equal(!!retry,unavailable);
  if(retry){retry.props.onClick();assert.equal(reloads,2);}h.dispose();
 }
});

test('官方身份同步失败时，自配模型仍可加载',async()=>{
 const h=harness({'@/utils/modelSync':{syncBuiltinModelAuth:async()=>{throw Error('offline');}},'@/api':{credentialApi:{list:async()=>({credentials:[{id:'custom',data:{type:'custom'}}]})},modelApi:{list:async()=>({models:[{name:'own-model'}]})}}});
 const{fetchGroups}=h.load('hooks/useAvailableModels.ts','\nexport {fetchGroups};');const groups=await fetchGroups();assert.equal(groups.custom[0].models[0].name,'own-model');h.dispose();
});
test('仅自配模型的选择器不请求已退役的身份或额度服务',async()=>{
 const calls=[];
 const h=harness({'@/utils/modelSync':{syncBuiltinModelAuth:async()=>calls.push('auth'),fetchBuiltinQuota:async()=>{calls.push('quota');throw Error('not used');}},'@/api':{credentialApi:{list:async()=>({credentials:[{id:'tora-official',data:{type:'tora_official'}},{id:'custom',data:{type:'custom'}}]})},modelApi:{list:async type=>{calls.push(type);return{models:[{name:'own-model'}]};}}}});
 const{fetchGroups}=h.load('hooks/useAvailableModels.ts','\nexport {fetchGroups};');const groups=await fetchGroups(false);assert.deepEqual(calls,['custom']);assert.equal(groups.tora_official,undefined);assert.equal(groups.custom[0].models[0].name,'own-model');h.dispose();
});

test('Codex 订阅页在未连接和已连接状态下都使用全宽模型布局', async () => {
 for(const connected of [false,true]){
  let back=0;
  const h=harness({'@/api/codex':{codexApi:{status:async()=>({connected,models:[],storage:'memory'}),models:async()=>({models:[{id:'fixture-codex',name:'Fixture Codex'}],selected:[]})}}});
  const {CodexSubscriptionView}=h.load('components/dialog/CodexSubscriptionView.tsx');
  const render=()=>h.render(()=>CodexSubscriptionView({onBack:()=>{back++;},onChanged(){},onDone(){}}));
  assert.equal(render().props['data-model-form'],true);
  await tick();const view=render();
  assert.equal(view.props['data-model-form'],true);
  assert.equal(view.props['data-testid'],'codex-subscription');
  assert.ok(connected?find(view,node=>node.props.children==='codex.connected'):find(view,node=>node.type==='Button'&&JSON.stringify(node.props.children).includes('codex.login')));
  find(view,node=>node.props['aria-label']==='modelSection.aria.back').props.onClick();
  assert.equal(back,1);h.dispose();
 }
});

test('添加模型移除 Coding Plan 入口，仅表单展开设置区两侧宽度', async () => {
 const calls=[];
 const h=harness({
  '@/utils/authStore':{getToken:()=> 'fixture'},
  '@/utils/modelSync':{cloudFetch:async path=>{calls.push(path);return Response.json({models:[]});},syncLocalModelMirror:async()=>{}},
  '@/api/codex':{CODEX_PROVIDER:'codex_subscription',codexApi:{status:async()=>({models:[]})}},
  '@/lib/query-client':{queryClient:{invalidateQueries:async()=>{}}},
 });
 const {ModelSection}=h.load('components/dialog/SettingsDialog.tsx');
 const render=()=>h.render(()=>ModelSection());
 let tree=render();await tick();tree=render();
 find(tree,node=>node.type==='Button'&&JSON.stringify(node.props.children).includes('modelSection.addModel')).props.onClick();
 tree=render();
 assert.equal(find(tree,node=>node.type==='button'&&JSON.stringify(node.props.children).includes('modelSection.plans.title')),null);
 assert.ok(find(tree,node=>node.props?.['data-testid']==='add-codex-subscription'));
 assert.ok(find(tree,node=>node.type==='button'&&JSON.stringify(node.props.children).includes('modelSection.providers.custom')));
 find(tree,node=>node.type==='button'&&JSON.stringify(node.props.children).includes('DeepSeek')).props.onClick();
 const form=render();
 assert.equal(form.props['data-model-form'],true);
 assert.ok(find(form,node=>node.type==='input'&&node.props.type==='password'));
 assert.match(readFileSync(new URL('components/dialog/SettingsDialog.tsx',base),'utf8'),/max-w-4xl[^"\n]*has-\[\[data-model-form\]\]:max-w-none/);
 assert.ok(!calls.some(path=>path.includes('/plans')));
 h.dispose();
});

test('模型设置不应用切换账号后或卸载后迟到的响应',async()=>{
 for(const action of ['account','unmount']){
  const response=deferred(),writes=[];let token='A';
  const h=harness({'@/utils/authStore':{getToken:()=>token},'@/utils/modelSync':{cloudFetch:()=>response.promise,syncLocalModelMirror:async(...args)=>writes.push(args)}});
  const{ModelSection}=h.load('components/dialog/SettingsDialog.tsx');h.render(()=>ModelSection());
  if(action==='account')token='B';else h.dispose();
  response.resolve(Response.json({models:[{id:'old',provider:'custom',model:'old-account-model',baseURL:'https://fixture.invalid',apiKey:'synthetic',enabled:true}]}));await tick();
  assert.equal(writes.length,0);if(action==='account'){assert.ok(!JSON.stringify(h.render(()=>ModelSection())).includes('old-account-model'));h.dispose();}
 }
});

test('发送在 streaming 渲染之前失败也能清除思考占位',async()=>{
 const accepted=deferred();const h=harness({
  '@/hooks/useSkills':{useSkills:()=>({skills:[]})},'./SlashCommandMenu':{commandsToSlashItems:()=>[],fromLibrary:()=>[]},
  './useChatAutoScroll':{useChatAutoScroll:()=>({resume(){}})},'@agentscope-ai/agentscope/message':{getContentBlocks:()=>[]},
  '@agentscope-ai/agentscope/event':{ReplyFinishedReason:{EXCEED_MAX_ITERS:'exceed'}},
 });
 const{ChatContent}=h.load('components/chat/ChatContent.tsx');
 const user={id:'user',role:'user',created_at:'2026-11-08',content:[{type:'text',text:'test'}]};
 const render=()=>h.render(()=>ChatContent({msgs:[user],phase:'idle',onSend:()=>accepted.promise,onUserConfirm(){}}));
 const sending=find(render(),node=>node.type==='TextInput').props.onSend([{type:'text',text:'next'}]);await tick();assert.ok(find(render(),node=>node.type==='AssistantThinkingMessage'));
 accepted.resolve();await sending;assert.equal(find(render(),node=>node.type==='AssistantThinkingMessage'),null);h.dispose();
});

test('网页版模型配置可新增且不保留提交的密钥，账号切换丢弃旧列表响应', {skip: !existsSync(new URL('../website/tochat/src/CustomModels.tsx', import.meta.url))}, async()=>{
 const calls=[];const h=harness({'./i18n':{webText:value=>value},'./api':{webJSON:async(path,init)=>{calls.push({path,body:JSON.parse(init.body)});return{status:'ok'};}}});
 const{CustomModelsDialog}=h.load('../../../../website/tochat/src/CustomModels.tsx');const props={open:true,onOpenChange(){},models:[],onChanged:async()=>{}};const render=()=>h.render(()=>CustomModelsDialog(props));
 let tree=render();find(tree,n=>n.type==='input'&&n.props.type==='url').props.onChange({target:{value:'https://provider.example.com/v1'}});
 tree=render();find(tree,n=>n.type==='input'&&n.props.required&&!n.props.type).props.onChange({target:{value:'my-model'}});
 tree=render();find(tree,n=>n.type==='input'&&n.props.type==='password').props.onChange({target:{value:'synthetic-key'}});
 find(render(),n=>n.type==='form').props.onSubmit({preventDefault(){}});await tick();assert.equal(calls[0].path,'models');assert.equal(calls[0].body.apiKey,'synthetic-key');assert.equal(find(render(),n=>n.type==='input'&&n.props.type==='password').props.value,'');h.dispose();
 const first=deferred();let token='A',count=0;
 const catalog=harness({'./adapters/authStore':{getToken:()=>token},'./api':{webJSON:async()=>++count===1?first.promise:{models:[{id:'B-model'}]}}});
 const{useCustomModels}=catalog.load('../../../../website/tochat/src/CustomModels.tsx');const load=()=>catalog.render(()=>useCustomModels(token));load();token='B';load();await tick();assert.equal(load().models[0].id,'B-model');first.resolve({models:[{id:'A-model'}]});await tick();assert.equal(load().models[0].id,'B-model');catalog.dispose();
});

test('live quota recovery repopulates a cached failed official group without losing custom models',()=>{
 const cached={tora_official:[{credential:{id:'tora-official',data:{type:'tora_official'}},models:[{name:'gpt-6-sol'},{name:'gemini-3.8-flash'}],unavailable:true}],custom:[{credential:{id:'personal',data:{type:'custom'}},models:[{name:'personal-model'}]}]};
 let live={isError:true,data:undefined,refetch(){}};
 const h=harness({'@tanstack/react-query':{useQuery:options=>options.queryKey[0]==='available-models'?{data:cached,isPending:false,error:null,refetch(){}}:live},'@/lib/query-client':{queryClient:{invalidateQueries(){}}}});
 const{useAvailableModels}=h.load('hooks/useAvailableModels.ts');const render=()=>h.render(()=>useAvailableModels(false,true));
 assert.equal(render().builtinUnavailable,true);assert.equal(render().groups.tora_official[0].models.length,2);
 live={isError:false,data:{enabled:true,models:[{id:'gpt-6-sol',enabled:true},{id:'gemini-3.8-flash',enabled:false}]},refetch(){}};
 const recovered=render();assert.equal(recovered.builtinUnavailable,false);assert.deepEqual(Array.from(recovered.groups.tora_official[0].models,m=>m.name),['gpt-6-sol']);assert.equal(recovered.groups.custom[0].models[0].name,'personal-model');h.dispose();
});

test('fresh-session adoption recovers a fast reply already persisted before its SSE attachment',async()=>{
 let sessionId=null,fresh=false;const history=[{id:'server-user',role:'user',content:[]},{id:'fast-reply',role:'assistant',content:[{type:'text',text:'instant result'}],finished_at:'2026-10-04T00:00:00Z'}];
 const h=harness({'@/api':{takeFreshlyCreated:()=>{const value=fresh;fresh=false;return value;},sessionApi:{create:async()=>{fresh=true;return {session_id:'fast-session'};},messages:async()=>({messages:history,is_running:false}),async *streamEvents(){yield{kind:'status',mode:'initial',streamId:'fast-stream'};}},chatApi:{trigger:async()=>{}}}});
 const {useMessages}=h.load('hooks/useMessages.ts');const render=()=>h.render(()=>useMessages('agent',sessionId,{onSessionCreated:id=>{sessionId=id;}}));
 await render().send([{type:'text',text:'hello'}]);render();await tick();const result=render();assert.deepEqual(Array.from(result.msgs,message=>message.id),['server-user','fast-reply']);assert.equal(result.phase,'idle');h.dispose();
});

test('ToChat mode switcher disappears on optimistic send and restored sessions, returns only for a fresh draft',async()=>{
 let params={agentId:'agent'},msgs=[],phase='idle';
 const h=harness({
  'react-router-dom':{useNavigate:()=>()=>{},useParams:()=>params,useSearchParams:()=>[new URLSearchParams()]},
  '@/hooks/useAgents':{useAgents:()=>({agents:[{id:'agent',data:{name:'Covey'}}]})},
  '@/hooks/useSessions':{useSessions:()=>({sessions:[],loading:true,refetch:async()=>{}})},
  '@/hooks/useMessages':{useMessages:()=>({msgs,phase,loading:false,send:()=>{phase='streaming';}})},
  '@/hooks/useMotionSettings':{useMotionSettings:()=>({effective:'off',clickEnabled:false})},
  '@/lib/applicationModes':{readToChatSource:()=> 'custom',modeCopy:()=>key=>key},
  '@/utils/authStore':{getToken:()=>''},
  'framer-motion':{motion:{span:'span'}},
 });
 const {ToChatConversation}=h.load('pages/tochat/index.tsx','\nexport {ToChatConversation};');
 const render=()=>h.render(()=>ToChatConversation()),switcher=tree=>find(tree,node=>node.props?.['data-testid']==='tochat-task-switcher');
 let tree=render();assert.ok(switcher(tree));
 await find(tree,node=>node.type==='ChatContent').props.modelControl.props.onChange({type:'openai_compatible',credential_id:'fixture',model:'fixture'});
 tree=render();assert.ok(switcher(tree));find(tree,node=>node.type==='ChatContent').props.onSend([{type:'text',text:'first message'}]);
 assert.equal(switcher(render()),null,'hidden before session creation and first message render');
 phase='idle';msgs=[{role:'user',content:[]}];assert.equal(switcher(render()),null,'first message keeps the mode locked after completion');
 params={agentId:'agent',sessionId:'existing'};msgs=[];assert.equal(switcher(render()),null,'no flash while existing history is loading');
 params={agentId:'agent'};assert.ok(switcher(render()),'new conversation restores mode choice');h.dispose();
});

test('website AI title captures language, remains deferred and preserves subsequent conversation history', {skip:!existsSync(new URL('../website/tochat/src/useWebConversation.ts',import.meta.url))}, async()=>{
 const gate=deferred(),stored=new Map(),titles=[],requests=[],preference={language:'en-GB'};
 const h=harness({
  '@agentscope-ai/agentscope/event':{ReplyFinishedReason:{COMPLETED:'completed',ERROR:'error'}},
  './i18n.ts':{webText:value=>value},
  '@/i18n/useI18n':{useTranslation:()=>({t:key=>key,i18n:preference})},
  './api':{webFetch:async()=>({}),webJSON:async(path,init)=>{assert.equal(path,'title');requests.push(JSON.parse(init.body));return gate.promise;}},
  './stream':{readChatStream:async()=>({content:'main reply',reasoning:'',tools:[]})},
  './localFiles':{selectedDirectory:()=>({}),localToolDefinitions:[]},
  './storage':{saveConversation:async value=>stored.set(value.id,structuredClone(value)),applyConversationTitle:async(id,owner,title)=>{const old=stored.get(id);if(!old||old.owner!==owner||!old.naming?.pending)return null;const updated={...old,title:title||old.title,naming:{pending:false}};stored.set(id,updated);return updated;}},
 },{structuredClone});
 const {useWebConversation}=h.load('../../../../website/tochat/src/useWebConversation.ts');
 const opts={mode:'chat',model:'gpt-6-sol',effort:'high',search:false,confirmWrites:true,onUpdate(){},onQuota(){},onTitleUpdate:value=>titles.push(value)};
 const render=()=>h.render(()=>useWebConversation('fixture',null,opts));
 await render().send([{type:'text',text:'请修复手机输入时键盘遮住输入框的问题'}]);assert.equal(render().busy,false);assert.equal(titles.length,0,'main reply completes before naming resolves');
 preference.language='zh';
 await render().send([{type:'text',text:'第二条消息不参与标题生成'}]);assert.equal(requests.length,1);assert.equal(requests[0].userText,'请修复手机输入时键盘遮住输入框的问题');
 assert.equal(requests[0].language,'en-GB');
 gate.resolve({title:'Fix mobile keyboard overlap'});await tick();assert.equal(titles[0].title,'Fix mobile keyboard overlap');assert.equal(titles[0].titleLanguage,'en-GB');assert.equal(titles[0].messages.length,4,'background naming must retain both turns');h.dispose();
});

test('a stale naming/auth response cannot sign out a newly logged-in web account',{skip:!existsSync(new URL('../website/tochat/src/api.ts',import.meta.url))},async()=>{
 let token='first-account',cleared=0;const response=deferred();const h=harness({'./adapters/authStore':{getToken:()=>token,delToken:async()=>cleared++,delEmail:async()=>cleared++}},{fetch:()=>response.promise});
 const {webFetch}=h.load('../../../../website/tochat/src/api.ts');const old=webFetch('title');token='second-account';response.resolve(Response.json({detail:'expired'},{status:401}));await old;assert.equal(cleared,0);h.dispose();
});


test('IME candidate Enter never sends, including Safari compositionend ordering; next Enter still sends', () => {
  let now = 1000; const sent = [];
  const h = harness({}, { performance: { now: () => now } });
  const { TextInput } = h.load('components/chat/TextInput.tsx');
  const render = () => find(h.render(() => TextInput({onSend: blocks => sent.push(blocks)}, null)), node => node.type === 'textarea').props;
  let editor = render(); editor.onChange({target:{value:'输入法测试'}}); editor = render();
  const enter = (native = {}, shiftKey = false) => editor.onKeyDown({key:'Enter',shiftKey,nativeEvent:native,preventDefault(){}});
  editor.onCompositionStart(); enter(); assert.equal(sent.length, 0);
  editor.onCompositionEnd({currentTarget:{value:'输入法测试'}}); enter(); assert.equal(sent.length, 0);
  editor.onKeyUp({key:'Enter'}); enter(); assert.equal(sent.length, 1);
  editor = render(); editor.onChange({target:{value:'另一次测试'}}); editor = render();
  now += 100; enter({keyCode:229}); enter({isComposing:true}); enter({},true); assert.equal(sent.length, 1);
  editor.onCompositionEnd({currentTarget:{value:'另一次测试'}}); now += 81; enter(); assert.equal(sent.length, 2);
  h.dispose();
});

test('retired Doubao stays out of ToChat and ToCode menus',()=>{
 const id='doubao-seed-2-1-lite-260915',h=harness();
 const {OfficialModelSelect}=h.load('components/select/OfficialModelSelect.tsx');
 const render=mode=>h.render(()=>OfficialModelSelect({model:'deepseek-flash',effort:'high',mode,onModel(){},onEffort(){}}));
 assert.equal(find(render('chat'),node=>node.type==='DropdownMenuRadioItem'&&node.props.value===id),null);
 assert.equal(find(render('work'),node=>node.type==='DropdownMenuRadioItem'&&node.props.value===id),null);
 const {chatAttachmentTypes}=h.load('lib/chatAttachments.ts');assert.ok(!chatAttachmentTypes(id,'chat').includes('audio/wav'));assert.ok(!chatAttachmentTypes(id,'chat').includes('video/mp4'));assert.ok(!chatAttachmentTypes(id,'work').includes('video/mp4'));assert.ok(!chatAttachmentTypes('gpt-6-sol','chat').includes('audio/wav'));h.dispose();
 const code=harness({'@/hooks/useAvailableModels':{useAvailableModels:()=>({groups:{tora_official:[{credential:{id:'tora-official',data:{type:'tora_official'}},models:[{name:id,input_types:['text']},{name:'gpt-6-sol',input_types:['text']}]}]},loading:false,refetch(){}})}});
 const {LlmSelect}=code.load('components/select/LlmSelect.tsx');const tree=code.render(()=>LlmSelect({}));assert.equal(find(tree,node=>node.type==='button'&&find(node,child=>child.props?.children==='Doubao Seed 2.1 Lite')),null);code.dispose();
});


test('submission-only disabling keeps drafts editable and prevents Enter and send clicks',()=>{
 const h=harness(),sent=[];
 const{TextInput}=h.load('components/chat/TextInput.tsx');
 const render=()=>h.render(()=>TextInput({sendDisabled:true,onSend:value=>sent.push(value)},null));
 let tree=render(),editor=find(tree,node=>node.type==='textarea');
 assert.equal(editor.props.disabled,false);
 editor.props.onChange({target:{value:'保留输入草稿'}});
 tree=render();editor=find(tree,node=>node.type==='textarea');
 assert.equal(editor.props.value,'保留输入草稿');
 editor.props.onKeyDown({key:'Enter',nativeEvent:{},preventDefault(){}});
 assert.equal(sent.length,0);
 const button=find(tree,node=>node.type==='Button'&&node.props['aria-label']==='textInput.send');
 assert.equal(button.props.disabled,true);button.props.onClick();assert.equal(sent.length,0);
 assert.equal(find(render(),node=>node.type==='textarea').props.value,'保留输入草稿');
 h.dispose();
});

test('locked official models have no subscription column and reject selection callbacks',()=>{
 const h=harness(),chosen=[];
 const{OfficialModelSelect}=h.load('components/select/OfficialModelSelect.tsx');
 const tree=h.render(()=>OfficialModelSelect({model:'deepseek-flash',effort:'high',mode:'chat',models:[{id:'claude-haiku-5-5',enabled:true,allowed:false,minimumPlan:'pro'},{id:'deepseek-flash',enabled:true,allowed:true}],onModel:id=>chosen.push(id),onEffort(){}}));
 const locked=find(tree,node=>node.type==='DropdownMenuRadioItem'&&node.props.value==='claude-haiku-5-5');
 assert.equal(locked.props.disabled,true);
 assert.match(locked.props.className,/data-disabled:cursor-not-allowed/);
 assert.match(locked.props.className,/data-disabled:pointer-events-auto/);
 assert.ok(!JSON.stringify(locked).includes('requiresPlan'));
 const group=find(tree,node=>node.type==='DropdownMenuRadioGroup'&&node.props.value==='deepseek-flash');
 group.props.onValueChange('claude-haiku-5-5');assert.equal(chosen.length,0);
 group.props.onValueChange('deepseek-flash');assert.deepEqual(chosen,['deepseek-flash']);
 h.dispose();
});

test('设置入口与现有板块一致，旧主题页入口回退到通用',()=>{
 const h=harness();const {normalizeSettingsSection,SETTINGS_SECTIONS}=h.load('lib/openSettings.ts');
 assert.ok(SETTINGS_SECTIONS.includes('developer'));
 for(const value of ['theme',null,'',42,{}])assert.equal(normalizeSettingsSection(value),'general');
 assert.equal(normalizeSettingsSection('quota'),'general');
 for(const value of ['model','agent','usage','developer'])assert.equal(normalizeSettingsSection(value),value);
 h.dispose();
});

test('Grok official picker retains four supported efforts and server availability across chat/work/ToCode',()=>{
 const h=harness();const models=h.load('lib/tochatModels.ts');
 assert.equal(models.toChatEffort('grok-4.7','xhigh'),'xhigh');assert.equal(models.toChatEffort('grok-4.7','max'),'high');
 for(const mode of ['chat','work','tocode'])assert.equal(models.modelAllowedInMode('grok-4.7',mode),true);
 assert.equal(models.modelAvailable('grok-4.7',[]),false);assert.equal(models.modelAvailable('grok-4.7',[{id:'grok-4.7',enabled:true}]),true);
 const{OfficialModelSelect}=h.load('components/select/OfficialModelSelect.tsx');
 const tree=h.render(()=>OfficialModelSelect({model:'grok-4.7',effort:'xhigh',models:[{id:'grok-4.7',enabled:true}],onModel(){},onEffort(){}}));
 const group=find(tree,node=>node.type==='DropdownMenuRadioGroup'&&node.props.value==='xhigh');
 assert.deepEqual(Array.from(group.props.children,item=>item.props.value),['low','medium','high','xhigh']);h.dispose();
});

test('GLM preserves the original picker with only low/high/max and text-only GLM attachments',()=>{
 const h=harness(),models=h.load('lib/tochatModels.ts'),{OfficialModelSelect}=h.load('components/select/OfficialModelSelect.tsx'),{chatAttachmentTypes}=h.load('lib/chatAttachments.ts');
 for(const model of ['glm-5.3']){
  for(const mode of ['chat','work','tocode'])assert.equal(models.modelAllowedInMode(model,mode),true);
  assert.equal(models.toChatEffort(model,'max'),'max');assert.equal(models.toChatEffort(model,'medium'),'high');assert.equal(models.modelAvailable(model,[]),false);
  const tree=h.render(()=>OfficialModelSelect({model,effort:'max',models:[{id:model,enabled:true}],onModel(){},onEffort(){}}));
  const group=find(tree,node=>node.type==='DropdownMenuRadioGroup'&&node.props.value==='max');assert.deepEqual(Array.from(group.props.children,item=>item.props.value),['low','high','max']);
 }
 assert.equal(chatAttachmentTypes('glm-5.3').length,0);h.dispose();
});

test('Claude 5.5 picker replaces Opus 5 without silently changing saved selections',()=>{
 const h=harness(),models=h.load('lib/tochatModels.ts'),{OfficialModelSelect}=h.load('components/select/OfficialModelSelect.tsx');
 assert.equal(models.TOCHAT_MODELS.some(m=>m.id==='claude-opus-5'),false);
 assert.equal(models.toChatModel('claude-opus-5').id,'claude-opus-5');
 assert.equal(models.modelAvailable('claude-opus-5',[{id:'claude-opus-5',enabled:true}]),false);
 for(const id of ['claude-opus-5-5','claude-sonnet-5-5','claude-haiku-5-5']){
  assert.equal(models.modelAvailable(id,[{id,enabled:true}]),true);
  const tree=h.render(()=>OfficialModelSelect({model:id,effort:'max',models:[{id,enabled:true}],onModel(){},onEffort(){}}));
  const group=find(tree,node=>node.type==='DropdownMenuRadioGroup'&&node.props.value==='max');assert.deepEqual(Array.from(group.props.children,item=>item.props.value),['low','medium','high','xhigh','max']);
  assert.equal(find(tree,node=>node.type==='DropdownMenuRadioItem'&&node.props.value==='claude-opus-5'),null);
 }h.dispose();
});

test('changed-files panel entry carries its recorded diff instead of requesting an unrelated Git diff',()=>{
 const requests=[],h=harness({'@/lib/openPanel':{requestPanel:(...args)=>requests.push(args)}});
 const{ChangedFilesCard}=h.load('components/chat/tool-renderers/ChangedFilesCard.tsx');
 const files=[{path:'/project/page.html',name:'page.html',dir:'/project',added:1,removed:0,diff:'@@ -0,0 +1 @@\n+<html>'}];
 const tree=h.render(()=>ChangedFilesCard({files}));find(tree,node=>node.type==='Button').props.onClick();
 assert.equal(requests[0][0],'diff');assert.match(requests[0][1].diff,/page.html/);assert.match(requests[0][1].diff,/\+<html>/);assert.equal(requests[0][1].root,'/project/page.html');h.dispose();
});

test('recorded diff renders without a Git error or a misleading refresh action',()=>{
 const h=harness(),{DiffPanel}=h.load('components/panel/DiffPanel.tsx');
 const tree=h.render(()=>DiffPanel({diff:'--- /dev/null\n+++ b/page.html\n@@ -0,0 +1 @@\n+<html>',error:null,loading:false,root:'/project/page.html'}));
 assert.equal(find(tree,node=>node.type==='PanelEmpty'),null);assert.equal(find(tree,node=>node.type==='Button'),null);h.dispose();
});

test('sidebar flattens Code/work histories and isolates ToChat chat, retaining session identity',()=>{
 const rows=[['chat-only','tochat','chat','2026-10-10T04:00:00Z'],['work-only','tochat','work','2026-10-10T03:00:00Z'],['code-only','tocode','work','2026-10-10T02:00:00Z'],['legacy',undefined,undefined,'2026-10-10T01:00:00Z']].map(([id,application_mode,task_mode,updated_at])=>({session:{id,updated_at,created_at:updated_at,origin:{type:'user'},config:{name:id,application_mode,task_mode,cwd:id==='code-only'?'/project':null}}}));
 for(const [pathname,search,expected] of [['/chat/agent/code-only','',['work-only','code-only','legacy']],['/tochat/agent/work-only','?task=work',['work-only','code-only','legacy']],['/tochat/agent/chat-only','?task=chat',['chat-only']]]){
  const nav=[],h=harness({'date-fns':{format:()=>''},'react-router-dom':{useLocation:()=>({pathname,search}),useNavigate:()=>url=>nav.push(url)},'@/hooks/useAgents':{useAgents:()=>({agents:[{id:'agent',data:{name:'Covey'}}]})},'@/hooks/useSessions':{useSessions:()=>({sessions:rows,refetch(){},update(){},remove(){}})}});
  const{SessionListSection}=h.load('components/layout/SessionListSection.tsx'),tree=h.render(()=>SessionListSection());
  const buttons=[];function collect(node){if(!node)return;if(Array.isArray(node)){node.forEach(collect);return;}if(typeof node!=='object')return;if(node.type==='SidebarMenuButton')buttons.push(node);collect(node.props?.children);}collect(tree);
  assert.deepEqual(buttons.map(node=>find(node,child=>child.type==='span')?.props.children),expected);
  assert.equal(find(tree,node=>node.type==='SidebarGroupLabel').props.children,'conversationList.title');assert.equal(find(tree,node=>node.type==='section'&&node.props.className?.includes('group/project')),null);
  buttons[0].props.onClick();assert.equal(nav[0],pathname.startsWith('/tochat')?`/tochat/agent/${expected[0]}?task=${search.includes('work')?'work':'chat'}`:`/chat/agent/${expected[0]}`);h.dispose();
 }
});

test('switching between Code and ToChat work keeps the same ID; chat starts a separate Code draft',()=>{
 for(const [pathname,search,kind,next,expected] of [['/chat/agent/work-id','','work','tochat','/tochat/agent/work-id?task=work'],['/tochat/agent/work-id','?task=work','work','tocode','/chat/agent/work-id'],['/tochat/agent/chat-id','?task=chat','chat','tocode','/chat/agent']]){
  const nav=[],h=harness({'react-router-dom':{useLocation:()=>({pathname,search}),useNavigate:()=>url=>nav.push(url)},'@/hooks/useSessions':{useSessions:()=>({sessions:[{session:{id:kind==='work'?'work-id':'chat-id',config:{application_mode:kind==='chat'?'tochat':'tocode',task_mode:kind}}}]})},'@/lib/applicationModes':{modeCopy:()=>key=>key}});
  const{ApplicationModeSwitcher}=h.load('components/layout/ApplicationModeSwitcher.tsx'),tree=h.render(()=>ApplicationModeSwitcher());const menu=find(tree,node=>node.type==='DropdownMenuContent');menu.props.children[next==='tochat'?0:1].props.onSelect();assert.deepEqual(nav,[expected]);h.dispose();
 }
});

test('live webpage preview artifact survives reply completion and retains the reply identity',async()=>{
 const messageSdk=await import(require.resolve('@agentscope-ai/agentscope/message'));
 const preview={kind:'html',entry:'/project/index.html',url:'http://127.0.0.1:51111/index.html'};
 const h=harness({'@agentscope-ai/agentscope/message':messageSdk,'@/lib/sound':{playNotificationSound(){}},'@/context/AudioContext':{useAudioManager:()=>null},'@/api':{takeFreshlyCreated:()=>false,sessionApi:{messages:async()=>({messages:[],is_running:false}),async *streamEvents(){
  yield {kind:'event',event:{type:'REPLY_START',reply_id:'web-reply',name:'assistant'}};
  yield {kind:'event',event:{type:'CUSTOM',name:'web_preview_ready',value:{reply_id:'web-reply',preview}}};
  yield {kind:'event',event:{type:'REPLY_END',reply_id:'web-reply',finished_reason:'completed'}};
 }},chatApi:{}}});
 const{useMessages}=h.load('hooks/useMessages.ts');const render=()=>h.render(()=>useMessages('agent','site-session'));
 render();await tick();await tick();const state=render();assert.equal(state.phase,'idle');assert.equal(state.msgs.length,1);assert.equal(state.msgs[0].id,'web-reply');assert.equal(state.msgs[0].metadata.web_preview,preview);h.dispose();
});

test('website preview card opens an exclusive browser dock and keeps the conversation route',async()=>{
 const opened=[],panels=[],navigations=[];
 const h=harness({'react-router-dom':{useParams:()=>({agentId:'agent',sessionId:'session'}),useNavigate:()=>url=>navigations.push(url)},'@/api':{sessionApi:{preview:async()=>({url:'http://127.0.0.1:5173/'})}},'@/components/panel/BrowserPanel':{openBuiltinBrowserTab:async url=>opened.push(url)},'@/lib/openPanel':{requestPanel:(...args)=>panels.push(args)}},{navigator:{userAgent:'Electron fixture'}});
 const {WebPreviewCard}=h.load('components/chat/WebPreviewCard.tsx');const render=()=>h.render(()=>WebPreviewCard({replyId:'reply',entry:'/project/index.html'}));
 find(render(),node=>node.type==='Button').props.onClick();await tick();await tick();render();
 assert.deepEqual(opened,['http://127.0.0.1:5173/']);assert.equal(panels.length,1);assert.equal(panels[0][0],'browser');assert.equal(panels[0][1].exclusive,true);assert.deepEqual(navigations,[]);h.dispose();
});

test('ToChat work hosts the same right browser dock and closes it without navigating',async()=>{
 const listeners=new Map(),navigations=[],view={session:{id:'work',state:{},config:{application_mode:'tocode',task_mode:'work',chat_model_config:{credential_id:'tora-official',model:'gpt-6.1-sol'}}}};
 const h=harness({'react-router-dom':{useNavigate:()=>url=>navigations.push(url),useParams:()=>({agentId:'agent',sessionId:'work'}),useSearchParams:()=>[new URLSearchParams('task=work')]},'@/hooks/useAgents':{useAgents:()=>({agents:[{id:'agent',data:{name:'Covey'}}]})},'@/hooks/useSessions':{useSessions:()=>({sessions:[view],loading:false,refetch(){}})},'@/hooks/useMessages':{useMessages:()=>({msgs:[],loading:false,phase:'idle',send(){},interrupt(){}})},'@/hooks/useMotionSettings':{useMotionSettings:()=>({effective:'standard',clickEnabled:true})},'@/utils/authStore':{getToken:()=> 'fixture'},'@/utils/modelSync':{syncBuiltinModelAuth:async()=>{},fetchBuiltinQuota:async()=>Response.json({enabled:true,canUseAgent:true,models:[{id:'gpt-6.1-sol',enabled:true}]})},'@/lib/applicationModes':{modeCopy:()=>key=>key,readToChatSource:()=> 'official',TOCHAT_SOURCE_EVENT:'source'},'@/lib/openPanel':{OPEN_PANEL_EVENT:'open-panel'}},{window:{addEventListener:(name,fn)=>listeners.set(name,fn),removeEventListener:name=>listeners.delete(name),setInterval:()=>1,clearInterval(){}}});
 const {ToChatConversation}=h.load('pages/tochat/index.tsx','\nexport {ToChatConversation};');const render=()=>h.render(()=>ToChatConversation());render();await tick();
 listeners.get('open-panel')({detail:{key:'browser',exclusive:true}});const dock=find(render(),node=>node.type==='PanelDock');assert.ok(dock);assert.equal(JSON.stringify(dock.props.layout),'[["browser"]]');assert.ok(dock.props.panels.browser);assert.deepEqual(navigations,[]);
 dock.props.onClosePanel('browser');assert.equal(find(render(),node=>node.type==='PanelDock').props.layout.length,0);h.dispose();
});


test('内置工具名称随语言切换，未知工具保留原名', async () => {
  const i18next = require('i18next').createInstance();
  const locales = ['zh','zh-Hant','zh-HK','zh-TW','zh-Neko','lzh','en','en-US','en-GB','ja','ja-Neko','ko','fr','de','it','es','pt','ru','ar','hi'];
  const resources = Object.fromEntries(locales.map(lang => [lang, { translation: JSON.parse(readFileSync(new URL(`i18n/locales/${lang}.json`, base), 'utf8')) }]));
  await i18next.init({ lng: 'zh', resources, fallbackLng: false });
  const {getToolDisplayName} = harness().load('lib/toolDisplayName.ts');
  const names = Object.keys(resources.zh.translation.tool.names);
  for (const lang of locales) {
    await i18next.changeLanguage(lang);
    for (const name of names) {
      const label = getToolDisplayName(name, i18next.t.bind(i18next));
      assert.equal(label, resources[lang].translation.tool.names[name]);
      assert.ok(label && !label.startsWith('tool.'));
    }
    assert.equal(getToolDisplayName('mcp__custom__Read', i18next.t.bind(i18next)), 'mcp__custom__Read');
  }
  await i18next.changeLanguage('zh');
  assert.equal(getToolDisplayName('bash', i18next.t.bind(i18next)), '运行命令');
  assert.equal(getToolDisplayName('Read', i18next.t.bind(i18next)), '读取文件');
});

test('工具调用行和授权标题使用翻译，命令与输出保持原文', async () => {
  const i18next = require('i18next').createInstance();
  await i18next.init({lng:'zh', resources:{zh:{translation:JSON.parse(readFileSync(new URL('i18n/locales/zh.json',base),'utf8'))}}});
  const t = i18next.t.bind(i18next);
  const common = harness().load('components/chat/tool-renderers/_shared.tsx');
  const h = harness({'./_shared':common,'@/components/chat/tool-renderers/_shared.tsx':common,unidiff:require('unidiff')});
  const text = tree => tree == null ? '' : Array.isArray(tree) ? tree.map(text).join(' ') : typeof tree === 'object' ? text(tree.props?.children) : String(tree);
  for(const name of ['Bash','Read','Write','Edit','Glob','Grep','TaskCreate']) {
    const renderer = h.load(`components/chat/tool-renderers/${name}Renderer.tsx`)[`${name}Renderer`];
    const pair = {call:{id:'test', name, input:JSON.stringify({command:'echo Read', file_path:'/tmp/Read.txt', pattern:'Bash', old_string:'a',new_string:'b'})}, result:{state:'success',output:'1\tRead output'}};
    const before = JSON.stringify(pair);
    assert.equal(renderer.getDisplayName(pair.call,t), t(`tool.names.${name}`));
    assert.ok(text(renderer.renderHeader(pair,t)).includes(t(`tool.names.${name}`)));
    if(name==='Bash') {
      assert.ok(text(renderer.renderHeader(pair,t)).includes('echo Read'));
      const body=text(renderer.renderBody(pair,t));
      assert.ok(body.includes('输入') && body.includes('输出') && body.includes('Read output'));
    }
    if(name==='Read') assert.ok(text(renderer.renderHeader(pair,t)).includes('读取 1 行'));
    if(name==='TaskCreate') assert.ok(text(renderer.renderHeader(pair,t)).includes('未命名任务'));
    assert.equal(JSON.stringify(pair),before);
  }
  const fallback=h.load('components/chat/tool-renderers/DefaultRenderer.tsx');
  assert.equal(fallback.defaultGetDisplayName({name:'WebSearch'},t),'搜索网页');
  assert.equal(fallback.defaultGetDisplayName({name:'mcp__custom__Read'},t),'mcp__custom__Read');
});


test('首发替换 ToChat/ToCode 地址保留聊天实例，普通会话切换仍重新挂载',()=>{
 for(const section of ['tochat','chat']){
  let pathname=`/${section}/agent`;const fresh=new Set();
  const h=harness({
   'react-router-dom':{useLocation:()=>({pathname}),Outlet:'Outlet'},
   'framer-motion':{MotionConfig:'MotionConfig',motion:{div:'motion.div'}},
   '@/hooks/useMotionSettings':{useMotionSettings:()=>({effective:'standard',pageEnabled:true})},
   '@/api/session':{hasFreshlyCreated:id=>fresh.has(id)},
  });
  const {AppLayout}=h.load('components/layout/AppLayout.tsx');
  const route=()=>find(h.render(()=>AppLayout()),node=>node.props?.['data-app-route-content']!==undefined);
  const draft=route().key;
  fresh.add('first');pathname=`/${section}/agent/first`;
  assert.equal(route().key,draft,'正式会话地址不能卸载仍持有首条消息的组件');
  fresh.delete('first');assert.equal(route().key,draft,'接管标记消费后不能再次卸载');
  pathname=`/${section}/agent/other`;assert.notEqual(route().key,draft,'切换其它会话保持隔离');
  pathname=`/${section}/agent`;assert.equal(route().key,pathname,'返回空白对话重新挂载');
  fresh.add('different-agent');pathname=`/${section}/another/different-agent`;assert.equal(route().key,pathname,'不同代理不能接管本地消息');
  h.dispose();
 }
});

test('桌面首条消息在账号同步与空历史响应期间保持显示，发送后不重复',async()=>{
 let sessionId=null,fresh=false;const auth=deferred(),streamGate=deferred(),requests=[];
 const h=harness({'@/api':{
  takeFreshlyCreated:()=>{const value=fresh;fresh=false;return value;},
  sessionApi:{create:async()=>{fresh=true;return{session_id:'first'};},messages:async()=>({messages:[],is_running:false}),async *streamEvents(){yield{kind:'status',mode:'initial',streamId:'first-stream'};await streamGate.promise;}},
  chatApi:{trigger:async value=>requests.push(value)},
 }});
 const{useMessages}=h.load('hooks/useMessages.ts');
 const options={viewMode:'tochat',beforeSend:()=>auth.promise,onSessionCreated:id=>{sessionId=id;}};
 const render=()=>h.render(()=>useMessages('agent',sessionId,options));
 const sending=render().send([{type:'text',text:'首条消息不能消失'}]);await tick();render();await tick();
 assert.equal(requests.length,0,'账号同步未完成时尚未提交服务端');
 assert.equal(render().msgs[0]?.content[0]?.text,'首条消息不能消失');
 assert.equal(render().phase,'streaming');
 auth.resolve();await sending;await tick();
 assert.equal(requests.length,1);assert.equal(render().msgs.filter(m=>m.role==='user').length,1);
 assert.equal(requests[0].input.id,render().msgs[0].id);
 h.dispose();streamGate.resolve();
});


test('模型权限与 DeepSeek 体验控制选择和工作发送，自定义模型不受限制',()=>{
 const h=harness();const{modelAvailable,canUseWorkModel,modelRequirementLabel}=h.load('lib/tochatModels.ts');
 const quota={enabled:true,canUseAgent:false,subscription:null,trial:{remaining:5},models:[{id:'deepseek-flash',enabled:true,allowed:true,minimumPlan:'plus'},{id:'gpt-6-astra',enabled:true,allowed:false,minimumPlan:'max5'}]};
 assert.equal(modelAvailable('gpt-6-astra',quota.models),false);assert.equal(canUseWorkModel('gpt-6-astra',quota),false);assert.equal(canUseWorkModel('deepseek-flash',quota),true);
 assert.equal(modelRequirementLabel('gpt-6-astra',quota.models,(_key,params)=>params.plan),'Max 5x');
 assert.equal(canUseWorkModel('deepseek-flash',{...quota,trial:{remaining:0}}),false);
 assert.equal(canUseWorkModel('deepseek-flash',{...quota,subscription:{planId:'plus'},trial:{remaining:5}}),false,'订阅额度耗尽不能切换到免费体验绕过限额');
 h.dispose();
});

test('stale Doubao quota data cannot make a retired model selectable',()=>{
 const h=harness(),{modelAvailable,canUseWorkModel,humanVerificationNeeded}=h.load('lib/tochatModels.ts');
 const id='doubao-seed-2-1-lite-260915';
 const models=[{id,enabled:true,allowed:true,workAllowed:true}];
 const quota={canUseAgent:true,models,doubaoWork:{total:10,remaining:10,canUse:true}};
 for(const subscription of [null,{planId:'plus'}]){
  assert.equal(canUseWorkModel(id,{...quota,subscription}),false);
  assert.equal(modelAvailable(id,models,'chat'),false);
  assert.equal(modelAvailable(id,models,'work'),false);
  assert.equal(humanVerificationNeeded(id,{...quota,subscription},'work'),false);
 }
 h.dispose();
});

test('stale Doubao subscription data does not show retired quota labels',()=>{
 const h=harness(),{OfficialModelSelect}=h.load('components/select/OfficialModelSelect.tsx'),id='doubao-seed-2-1-lite-260915';
 const render=(mode,subscribed)=>h.render(()=>OfficialModelSelect({model:id,effort:'high',mode,subscribed,models:[{id,enabled:true,allowed:true,workAllowed:true}],onModel(){},onEffort(){}}));
 for(const [mode,subscribed] of [['work',true],['chat',true],['work',false]]){
  assert.equal(find(render(mode,subscribed),node=>['doubao-credits-label','doubao-free-label'].includes(node.props?.['data-testid'])),null);
 }
 h.dispose();
});

test('锁定的官方模型保留在列表中显示套餐门槛，个人模型仍可选择',()=>{
 const quota={enabled:true,models:[{id:'deepseek-flash',enabled:true,allowed:true},{id:'gpt-6-astra',enabled:true,allowed:false,minimumPlan:'max5'}]};
 const groups={tora_official:[{credential:{id:'tora-official',data:{type:'tora_official'}},models:[{name:'deepseek-flash'},{name:'gpt-6-astra'}]}],custom:[{credential:{id:'personal',data:{type:'openai_compatible'}},models:[{name:'personal-model'}]}]};
 const h=harness();const{modelGroupsWithQuota}=h.load('hooks/useAvailableModels.ts');const result=modelGroupsWithQuota(groups,quota,false);
 assert.equal(result.tora_official[0].models.length,2);assert.equal(result.custom[0].models[0].name,'personal-model');h.dispose();
});


test('人机验证只阻止缺少有效验证的免费体验，付费用户和豆包不反复验证',()=>{
 const h=harness();const{humanVerificationNeeded}=h.load('lib/tochatModels.ts');
 const quota={subscription:null,trial:{remaining:5},humanVerification:{required:true,verified:false,expiresAt:null}};
 assert.equal(humanVerificationNeeded('deepseek-flash',quota),true);assert.equal(humanVerificationNeeded('gpt-6-sol',quota),false);assert.equal(humanVerificationNeeded('doubao-seed-2-1-lite-260915',quota),false);
 assert.equal(humanVerificationNeeded('deepseek-flash',{...quota,subscription:{planId:'plus'}}),false);
 assert.equal(humanVerificationNeeded('deepseek-flash',{...quota,trial:{remaining:0}}),false);
 assert.equal(humanVerificationNeeded('deepseek-flash',{...quota,humanVerification:{required:true,verified:true}}),false);h.dispose();
});

test('Turnstile 过期、超时和错误清空旧令牌，重试可获得新令牌',async()=>{
 let callbacks,renders=0,resets=0;const tokens=[];
 const h=harness({}, {window:{turnstile:{render(_el,opts){callbacks=opts;renders++;return 'widget';},reset(){resets++;},remove(){}}},document:{documentElement:{classList:{contains:()=>true}}}});
 const{Turnstile}=h.load('components/auth/Turnstile.tsx');const props={action:'free_trial',onToken:token=>tokens.push(token)};
 const render=()=>h.render(()=>Turnstile(props,null),{deferEffects:true});let tree=render();find(tree,node=>node.type==='div'&&node.props.ref).props.ref.current={};h.flushEffects();await tick();
 callbacks.callback('first-proof');assert.equal(tokens.at(-1),'first-proof');
 for(const status of ['expired','timeout']){callbacks[status+'-callback']();assert.equal(tokens.at(-1),'');tree=render();assert.ok(find(tree,node=>node.props?.role==='alert'&&node.props.children==='humanVerification.'+status));}
 callbacks['error-callback']();assert.equal(tokens.at(-1),'');tree=render();find(tree,node=>node.type==='button'&&node.props.children==='error.retry').props.onClick();assert.equal(resets,1);
 callbacks.callback('new-proof');assert.equal(tokens.at(-1),'new-proof');assert.equal(renders,1);h.dispose();
});


test('人机验证失败不会放行发送，成功后才刷新额度；取消不会提交请求',async()=>{
 let accepted=false,requests=0,verified=0,resets=0;
 const h=harness({'@/utils/modelSync':{verifyBuiltinHuman:async()=>{requests++;return Response.json({verified:accepted},{status:accepted?200:403});}}});
 const{HumanVerificationControl}=h.load('components/auth/HumanVerificationControl.tsx');
 const render=()=>h.render(()=>HumanVerificationControl({onVerified:async()=>verified++}));
 let tree=render();find(tree,node=>node.type==='Button'&&node.props.children==='settings.account.captchaTitle').props.onClick();
 tree=render();assert.equal(find(tree,node=>node.type==='Dialog').props.open,true);
 find(tree,node=>node.type==='Button'&&node.props.children==='common.cancel').props.onClick();assert.equal(requests,0);assert.equal(find(render(),node=>node.type==='Dialog').props.open,false);
 find(render(),node=>node.type==='Button'&&node.props.children==='settings.account.captchaTitle').props.onClick();
 tree=render();const widget=find(tree,node=>node.type==='Turnstile');widget.props.ref.current={reset:()=>{resets++;widget.props.onToken('');}};widget.props.onToken('proof');
 tree=render();find(tree,node=>node.type==='Button'&&node.props.children==='humanVerification.continue').props.onClick();await tick();assert.equal(verified,0);assert.equal(resets,1);assert.equal(find(render(),node=>node.type==='Button'&&node.props.children==='humanVerification.continue').props.disabled,true);
 accepted=true;find(render(),node=>node.type==='Turnstile').props.onToken('new-proof');tree=render();find(tree,node=>node.type==='Button'&&node.props.children==='humanVerification.continue').props.onClick();await tick();assert.equal(verified,1);assert.equal(find(render(),node=>node.type==='Dialog').props.open,false);h.dispose();
});

test('remote catalog adds new models and updates labels, efforts, permissions, modes and cards without a compiled whitelist',()=>{
 const h=harness();const lib=h.load('lib/tochatModels.ts');
 const models=[{id:'remote-new',name:'远程添加',provider:'custom',context:256000,maxOutput:4096,input_modalities:['text'],efforts:['low'],modes:['chat','work'],enabled:true,allowed:true,minimumPlan:'plus',rates:{input:11,cached:2,output:22}}];
 assert.equal(lib.newerBuiltinQuota({catalogRevision:12,models},{catalogRevision:11,models:[]}).models[0].id,'remote-new');
 assert.equal(lib.toChatModel('remote-new',models).name,'远程添加');assert.equal(lib.toChatEffort('remote-new','high',models),'low');assert.equal(lib.modelAvailable('remote-new',models,'chat'),true);assert.equal(lib.modelAvailable('remote-new',models,'tocode'),false);
 assert.equal(lib.modelAvailable('remote-new',[{...models[0],allowed:false}],'chat'),false);assert.equal(lib.modelAvailable('remote-new',[],'chat'),false);assert.equal(lib.toChatModel('remote-new',[]).id,'remote-new');
 const{modelGroupsWithQuota}=h.load('hooks/useAvailableModels.ts');const groups={tora_official:[{credential:{id:'tora-official',data:{type:'tora_official'}},models:[{name:'deepseek-flash'}]}]};
 const result=modelGroupsWithQuota(groups,{catalogRevision:10,models,enabled:true},false);assert.equal(result.tora_official[0].models[0].name,'remote-new');assert.equal(result.tora_official[0].models[0].label,'远程添加');assert.equal(result.tora_official[0].models[0].context_size,256000);assert.deepEqual(Array.from(result.tora_official[0].models[0].input_types),['text']);
 const emptied=modelGroupsWithQuota(groups,{catalogRevision:11,models:[],enabled:false},true);assert.equal(emptied.tora_official[0].models.length,0);
 const {chatAttachmentTypes}=h.load('lib/chatAttachments.ts');assert.deepEqual(Array.from(chatAttachmentTypes('remote-new','chat',models)),[]);
 h.dispose();
});


test('Browser iframe new tabs stay local while a navigation is pending',async()=>{
 const h=harness();const {createIframeSurface}=h.load('components/panel/BrowserPanel.tsx','\nexport {createIframeSurface};');
 const listeners=new Map();const el={src:'',contentWindow:{location:{href:'about:blank'}},contentDocument:{title:''},addEventListener:(name,fn)=>listeners.set(name,fn),removeEventListener:name=>listeners.delete(name),getAttribute:name=>name==='src'?el.src:null};
 const surface=createIframeSurface(el);assert.equal(surface.currentUrl(),'');assert.equal(surface.canGoBack(),false);
 const pending=surface.navigate('https://example.test/');assert.equal(surface.currentUrl(),'https://example.test/');listeners.get('load')();await pending;h.dispose();
});

test('Tool dock delegates web pages and tools to one built-in browser strip',()=>{
 const h=harness({'framer-motion':{useIsPresent:()=>true,motion:{div:'motion.div'},AnimatePresence:'AnimatePresence'},'@/hooks/useMotionSettings':{useMotionSettings:()=>({effective:'off',clickEnabled:false})}});
 const {PanelDock}=h.load('components/panel/PanelDock.tsx');const closed=[],opened=[];
 let layout=[['browser','plan'],['terminal','plan']],active='plan',visible=true;
 const render=()=>h.render(()=>PanelDock({layout:visible?layout:[],activePanel:active,onActivePanelChange:key=>active=key,panels:{browser:{title:'Browser',content:'Unused wrapper'},plan:{title:'Plan',content:'Plan content'},terminal:{title:'Terminal',content:'Terminal content'}},onOpenPanel:key=>opened.push(key),onCloseDock:()=>visible=false,onClosePanel:key=>{closed.push(key);layout=layout.map(col=>col.filter(value=>value!==key));}}));
 let tree=render(),browser=find(tree,node=>node.type==='Lazy');const motion=find(tree,node=>typeof node.type==='function'&&node.type.name==='DockMotion');const motionTree=h.render(()=>motion.type(motion.props));assert.match(motionTree.props.className,/flex h-full min-h-0 min-w-0 flex-col/);assert.ok(browser);assert.equal(find(tree,node=>node.type==='TabsList'),null);assert.equal(browser.props.toolTabs.length,2);
 assert.equal(browser.props.activeTool,'plan');browser.props.onSelectTool('terminal');tree=render();browser=find(tree,node=>node.type==='Lazy');assert.equal(browser.props.activeTool,'terminal');
 browser.props.onCloseTool('terminal');tree=render();browser=find(tree,node=>node.type==='Lazy');assert.equal(browser.props.activeTool,'plan');assert.deepEqual(closed,['terminal']);
 browser.props.onCloseTool('plan');tree=render();browser=find(tree,node=>node.type==='Lazy');assert.equal(active,'browser');assert.equal(browser.props.activeTool,null);
 browser.props.onOpenTool('terminal');assert.deepEqual(opened,['terminal']);browser.props.onClose();assert.equal(find(render(),node=>node.type==='ResizablePanel'),null);assert.ok(layout.flat().includes('browser'));h.dispose();
});

test('Built-in browser uses its own tab bar for tools and hides web chrome on a tool page',()=>{
 const selected=[],closed=[],opened=[];
 const h=harness({'react-router-dom':{useNavigate:()=>()=>{},useLocation:()=>({pathname:'/chat/agent/session',search:''})}}, {navigator:{userAgent:'Fixture'},window:{location:{origin:'http://localhost',pathname:'/chat/agent/session',search:''}}});
 const{BrowserPanel}=h.load('components/panel/BrowserPanel.tsx');const content={type:'FixturePlan',props:{}};
 const render=activeTool=>h.render(()=>BrowserPanel({toolTabs:[{key:'plan',title:'Plan',content}],availableTools:[{key:'plan',title:'Plan',content}],activeTool,onSelectTool:key=>selected.push(key),onCloseTool:key=>closed.push(key),onOpenTool:key=>opened.push(key)}),{deferEffects:true});
 let tree=render('plan');const tab=find(tree,node=>node.props?.role==='tab');assert.equal(tab.props['aria-selected'],true);assert.equal(find(tree,node=>node.props?.className==='browser-toolbar'),null);
 assert.equal(find(tree,node=>node.props?.['data-browser-placeholder']).props.hidden,true);assert.equal(find(tree,node=>node===content),content);
 tab.props.onClick();assert.deepEqual(selected,['plan']);find(tree,node=>node.props?.['aria-label']==='browserPanel.closeTab Plan').props.onClick();assert.deepEqual(closed,['plan']);
 find(tree,node=>node.type==='DropdownMenuItem'&&node.key==='plan').props.onSelect();assert.deepEqual(opened,['plan']);
 tree=render(null);assert.ok(find(tree,node=>node.props?.className==='browser-toolbar'));assert.equal(find(tree,node=>node.props?.id==='browser-tool-plan').props.hidden,true);assert.equal(find(tree,node=>node===content),content);h.dispose();
});

test('Tool tabs safely migrate corrupt and duplicate old layouts and reopen existing tabs once',()=>{
 const h=harness();const tabs=h.load('lib/panelTabs.ts');
 assert.equal(JSON.stringify(tabs.normalizePanelLayout([['browser','plan'],['browser','terminal'],null,['unknown',{}]])),'[["browser","plan","terminal"]]');
 assert.deepEqual(Array.from(tabs.normalizePanelLayout({})),[]);
 assert.equal(JSON.stringify(tabs.openPanelInLayout([['browser','plan']],'browser')),'[["browser","plan"]]');
 assert.equal(JSON.stringify(tabs.closePanelInLayout([['browser','plan']],'browser')),'[["browser","plan"]]');
 assert.equal(tabs.nextPanelAfterClose(['browser','plan','terminal'],'plan','plan'),'terminal');
 assert.equal(tabs.nextPanelAfterClose(['browser','plan'],'plan','plan'),'browser');
 assert.equal(tabs.nextPanelAfterClose(['browser'],'browser','browser'),null);h.dispose();
});

test('Closing the last web/tool tab collapses the dock, preserves siblings and never recreates a blank tab',()=>{
 const element=()=>({src:'',style:{},dataset:{},contentWindow:{location:{href:'about:blank'}},contentDocument:{title:''},setAttribute(){},getAttribute(){return null;},addEventListener(){},removeEventListener(){},appendChild(){},remove(){}});
 const fixture=()=>{
  const window={location:{origin:'http://localhost',pathname:'/chat/agent/session',search:''},addEventListener(){},removeEventListener(){}};
  const h=harness({'react-router-dom':{useNavigate:()=>()=>{},useLocation:()=>({pathname:window.location.pathname,search:''})}}, {navigator:{userAgent:'Fixture'},window,document:{createElement:element,body:{appendChild(){}},querySelector:()=>null}});
  const lib=h.load('components/panel/BrowserPanel.tsx','\nexport {createTab,listTabs};');return {h,lib};
 };
 // Run real mount effects and the close-button callback, then re-render during exit.
 {const {h,lib}=fixture();let collapsed=0;const render=()=>h.render(()=>lib.BrowserPanel({onClose:()=>collapsed++}));
  render();let tree=render();assert.equal(lib.listTabs().length,1);
  find(tree,node=>node.props?.['aria-label']==='browserPanel.closeTab').props.onClick();render();assert.equal(collapsed,1);assert.equal(lib.listTabs().length,0);h.dispose();}
 // Other web tabs keep the dock open; its existing tab manager selects a sibling.
 {const {h,lib}=fixture();let collapsed=0;lib.createTab('iframe');lib.createTab('iframe');
  const tree=h.render(()=>lib.BrowserPanel({onClose:()=>collapsed++}),{deferEffects:true});
  find(tree,node=>node.props?.['aria-label']==='browserPanel.closeTab').props.onClick();assert.equal(collapsed,0);assert.equal(lib.listTabs().length,1);assert.equal(lib.listTabs()[0].active,true);h.dispose();}
 // Closing the last web page selects the remaining tool; closing that tool collapses.
 {const {h,lib}=fixture();let collapsed=0,selected=null,closed=null;lib.createTab('iframe');
  const props={toolTabs:[{key:'plan',title:'Plan',content:'Plan'}],onClose:()=>collapsed++,onSelectTool:key=>selected=key,onCloseTool:key=>closed=key};
  let tree=h.render(()=>lib.BrowserPanel(props),{deferEffects:true});find(tree,node=>node.props?.['aria-label']==='browserPanel.closeTab').props.onClick();assert.equal(selected,'plan');assert.equal(collapsed,0);
  tree=h.render(()=>lib.BrowserPanel({...props,activeTool:selected}),{deferEffects:true});find(tree,node=>node.props?.['aria-label']==='browserPanel.closeTab Plan').props.onClick();assert.equal(closed,'plan');assert.equal(collapsed,1);h.dispose();}
});


test('Auth flow uses the reference entry, then password, signup or OTP screens; no third-party buttons',async()=>{
 let registered=true;const calls=[],profiles=[];
 const lib=harness().load('lib/authFlow.ts');
 const h=harness({'@/utils/authStore':{getToken:()=>null},'@/lib/authFlow':{...lib,authRequest:async(path,body)=>{calls.push({path,body});if(path==='/auth/check')return{registered};if(path==='/auth/email-code')return{ok:true};if(path==='/auth/reset-verify')return{resetToken:'proof'};if(path==='/auth/reset-password')return{ok:true};return{token:'fixture-session',email:'user@fixture.invalid'};}}});
 const{AuthFlow}=h.load('components/auth/AuthFlow.tsx');const render=()=>h.render(()=>AuthFlow({onAuthenticated:profile=>profiles.push(profile)}));
 const action=label=>find(render(),node=>typeof node.type==='function'&&node.type.name==='AuthAction'&&node.props.label===`authFlow.${label}`);
 const field=label=>find(render(),node=>typeof node.type==='function'&&node.type.name==='AuthField'&&node.props.label===`authFlow.${label}`);
 let tree=render();assert.ok(find(tree,node=>node.type==='h1'&&node.props.children==='authFlow.loginTitle'));assert.ok(action('otherMethods'));assert.equal(calls.length,0);assert.equal(find(tree,node=>/Google|Apple|Microsoft/.test(String(node.props?.children??''))),null);
 action('continueLogin').props.onClick();field('email').props.onChange('user@fixture.invalid');action('continue').props.onClick();await tick();assert.ok(field('password'));
 // Email OTP is a separate purpose. The password is never sent with the OTP login.
 action('codeLogin').props.onClick();await tick();
 assert.equal(calls.at(-1).path,'/auth/email-code');assert.equal(calls.at(-1).body.purpose,'login');field('code').props.onChange('123456');action('continue').props.onClick();await tick();assert.equal(calls.at(-1).path,'/auth/email-login');assert.equal('password' in calls.at(-1).body,false);assert.equal(profiles.length,1);h.dispose();
 // New accounts use email + password, then verify the mailbox.
 registered=false;const signup=harness({'@/utils/authStore':{getToken:()=>null},'@/lib/authFlow':{...lib,authRequest:async(path,body)=>{calls.push({path,body});return path==='/auth/check'?{registered:false}:{ok:true};}}});
 const{AuthFlow:Signup}=signup.load('components/auth/AuthFlow.tsx');const sr=()=>signup.render(()=>Signup({onAuthenticated(){}}));
 find(sr(),node=>node.type==='button'&&node.props.children==='authFlow.signUp').props.onClick();find(sr(),node=>typeof node.type==='function'&&node.type.name==='AuthField').props.onChange('new@fixture.invalid');find(sr(),node=>typeof node.type==='function'&&node.type.name==='AuthAction'&&!node.props.secondary).props.onClick();await tick();assert.ok(find(sr(),node=>node.type==='h1'&&node.props.children==='authFlow.createPasswordTitle'));
 const password=find(sr(),node=>typeof node.type==='function'&&node.type.name==='AuthField'&&node.props.password);password.props.onChange('valid-password');find(sr(),node=>typeof node.type==='function'&&node.type.name==='AuthAction'&&!node.props.secondary).props.onClick();await tick();assert.equal(calls.at(-1).path,'/auth/email-code');assert.equal(calls.at(-1).body.purpose,'signup');signup.dispose();
});

test('Auth mode never renders a cached settings profile; every installed locale includes the new login and passkey copy',()=>{
 const h=harness({'@/utils/authStore':{getToken:()=> 'unverified',getEmail:()=> 'cached@fixture.invalid',getUsername:()=> 'cached'}});
 const{AccountSection}=h.load('components/dialog/AccountSection.tsx');const tree=h.render(()=>AccountSection({mode:'auth'}));assert.ok(find(tree,node=>node.type==='AuthFlow'));assert.equal(find(tree,node=>typeof node.type==='function'&&node.type.name==='AccountManager'),null);h.dispose();
 const localeHarness=harness();const{SUPPORTED_LANGUAGES}=localeHarness.load('i18n/languages.ts');
 const values=obj=>Object.values(obj).flatMap(value=>typeof value==='object'?values(value):[value]);
 for(const lang of [...SUPPORTED_LANGUAGES,'en','zh-Hant']){
  const pack=JSON.parse(readFileSync(new URL(`i18n/locales/${lang}.json`,base),'utf8')).authFlow;
  assert.ok(pack.otherMethods&&pack.passkeyLogin&&pack.passkeyManagerTitle&&pack.browser?.confirm,lang);assert.ok(values(pack).every(value=>typeof value==='string'&&value.trim()),lang);
  for(const key of ['{{email}}','{{seconds}}','{{count}}'])assert.ok(values(pack).some(value=>value.includes(key)),`${lang} ${key}`);
 }
 localeHarness.dispose();
});

test('A late auth response cannot overwrite a new identity or persist a session after the form unmounts',async()=>{
 const lib=harness().load('lib/authFlow.ts'),login=deferred();let token=null,authenticated=0;
 const h=harness({'@/utils/authStore':{getToken:()=>token},'@/lib/authFlow':{...lib,authRequest:async path=>path==='/auth/check'?{registered:true}:login.promise}});
 const{AuthFlow}=h.load('components/auth/AuthFlow.tsx');const render=()=>h.render(()=>AuthFlow({onAuthenticated:()=>authenticated++}));
 const action=()=>find(render(),node=>typeof node.type==='function'&&node.type.name==='AuthAction'&&!node.props.secondary);
 action().props.onClick();find(render(),node=>typeof node.type==='function'&&node.type.name==='AuthField').props.onChange('user@fixture.invalid');action().props.onClick();await tick();find(render(),node=>typeof node.type==='function'&&node.type.name==='AuthField').props.onChange('password');action().props.onClick();await tick();token='different-user';h.dispose();login.resolve({token:'old-result',email:'user@fixture.invalid'});await tick();assert.equal(authenticated,0);
});


test('冷启动只恢复工具标签信息，不自动打开浏览器或加载隐藏面板数据',()=>{
 const listeners=new Map(),options=[];
 const storage=new Map([['chat_panel_layout','[["browser","diff","checkpoint","mcp"]]'],['chat_panel_active','browser']]);
 const noop=()=>{},asyncNoop=async()=>{};
 const h=harness({
  '@/hooks/useSessions':{useSessions:()=>({sessions:[],refetch:asyncNoop})},
  '@/hooks/useAvailableModels':{useAvailableModels:()=>({groups:{},refetch:noop})},
  '@/hooks/useMessages':{useMessages:()=>({msgs:[],phase:'idle',subagentHitl:[]})},
  '@/hooks/useWorkspace.ts':{useWorkspace:(_a,_s,value)=>{options.push(['workspace',value]);return{mcps:[],skills:[]};}},
  '@/hooks/useKnowledgeBases':{useKnowledgeBases:()=>({knowledgeBases:[]})},
  '@/hooks/useKnowledgeBaseMiddlewareSchema':{useKnowledgeBaseMiddlewareSchema:enabled=>{options.push(['knowledge',enabled]);return{schema:null};}},
  '@/hooks/useWorkspaceStatus':{useWorkspaceStatus:()=>({status:null,refetch:asyncNoop})},
  '@/hooks/useToraData':{useToraData:(_a,_s,_cwd,value)=>{options.push(['tora',value]);return{checkpoints:[],refresh:asyncNoop};}},
  '@/lib/projectNaming':{getProjectDisplayName:()=>'',PROJECT_NAMES_CHANGED_EVENT:'project-changed'},
  '@/lib/openPanel':{OPEN_PANEL_EVENT:'tora:open-panel'},
  '@/utils/authStore':{getToken:()=>null},
 },{localStorage:{getItem:key=>storage.get(key)||null,setItem:(key,value)=>storage.set(key,value),removeItem:key=>storage.delete(key)},
 window:{location:{pathname:'/chat/agent',search:''},addEventListener:(name,cb)=>listeners.set(name,cb),removeEventListener:(name,cb)=>{if(listeners.get(name)===cb)listeners.delete(name);}}});
 const {ChatViewport}=h.load('pages/chat/ChatViewport.tsx');const render=()=>h.render(()=>ChatViewport({agentId:'agent',sessionId:null}));
 let tree=render(),dock=find(tree,node=>node.type==='PanelDock');
 assert.equal(dock.props.layout.length,0);assert.equal(JSON.parse(storage.get('chat_panel_layout'))[0].length,4,'保留标签信息供手动打开');
 assert.equal(options.find(([key])=>key==='workspace')[1].loadMcp,false);
 assert.equal(options.find(([key])=>key==='tora')[1].diff,false);
 find(tree,node=>node.props?.['aria-label']==='panelDock.toggle').props.onClick();tree=render();dock=find(tree,node=>node.type==='PanelDock');
 assert.equal(dock.props.layout.flat().length,4,'点击右侧栏按钮才恢复已存标签');
 dock.props.onCloseDock();tree=render();assert.equal(find(tree,node=>node.type==='PanelDock').props.layout.length,0);
 listeners.get('tora:open-panel')({detail:'browser'});tree=render();assert.ok(find(tree,node=>node.type==='PanelDock').props.layout.flat().includes('browser'),'显式 Browser 工具事件仍能打开');h.dispose();
});

test('浏览器仅挂载选中过的工具，切换标签保留已访问工具状态',()=>{
 const h=harness();const{RetainedToolBody}=h.load('components/panel/BrowserPanel.tsx','\nexport {RetainedToolBody};');
 const child={type:'ExpensiveTool'};
 assert.equal(h.render(()=>RetainedToolBody({active:false,children:child})),null);
 assert.equal(h.render(()=>RetainedToolBody({active:true,children:child})),child);
 assert.equal(h.render(()=>RetainedToolBody({active:false,children:child})),child);h.dispose();
});

test('侧栏可见性只记住同次运行，新加载模块默认关闭',()=>{
 const h=harness(),first=h.load('lib/panelTabs.ts');assert.equal(first.readPanelVisibility(),false);
 first.rememberPanelVisibility(true);assert.equal(first.readPanelVisibility(),true);
 assert.equal(h.load('lib/panelTabs.ts').readPanelVisibility(),false);
 first.rememberPanelVisibility(false);assert.equal(first.readPanelVisibility(),false);h.dispose();
});

test('模型目录按凭证隔离，排序不改写服务返回的结果',async()=>{
 const calls=[],models=[{name:'alpha'},{name:'zeta'}];
 const h=harness({'@/api':{credentialApi:{list:async()=>({credentials:[...['one','two','three'].map(id=>({id,data:{type:'provider-a'}})),{id:'four',data:{type:'provider-b'}}]})},
  modelApi:{list:async (type,id)=>{calls.push([type,id]);return{models};}}},'@/utils/modelSync':{syncBuiltinModelAuth:async()=>{}}});
 const{fetchGroups}=h.load('hooks/useAvailableModels.ts','\nexport {fetchGroups};');const groups=await fetchGroups();
 assert.deepEqual(calls,[['provider-a','one'],['provider-a','two'],['provider-a','three'],['provider-b','four']]);
 assert.equal(groups['provider-a'].length,3);assert.equal(groups['provider-b'].length,1);
 assert.deepEqual(models.map(model=>model.name),['alpha','zeta']);
 assert.deepEqual(Array.from(groups['provider-a'][0].models,model=>model.name),['zeta','alpha']);h.dispose();
});

test('对话删除先保存、等待视觉退出后刷新，失败不触发退出回调', async()=>{
 const saved=deferred(),exit=deferred(),calls=[];let fail=false;
 const h=harness({'@tanstack/react-query':{useQuery:()=>({data:[]}),useQueryClient:()=>({invalidateQueries:async()=>calls.push('refresh')})},
  '../api':{sessionApi:{delete:async()=>{calls.push('delete');await saved.promise;if(fail)throw Error('offline');}}}});
 const {useSessions}=h.load('hooks/useSessions.ts');const api=h.render(()=>useSessions('agent'));
 const removing=api.remove('first',async()=>{calls.push('exit');await exit.promise;});
 assert.deepEqual(calls,['delete']);saved.resolve();await tick();assert.deepEqual(calls,['delete','exit']);
 exit.resolve();await removing;assert.deepEqual(calls,['delete','exit','refresh']);
 fail=true;await assert.rejects(api.remove('second',async()=>calls.push('wrong-exit')),/offline/);
 assert.deepEqual(calls,['delete','exit','refresh','delete']);h.dispose();
});

function sessionSandFixture({fail=false}={}) {
 const saved=deferred(),sand=deferred(),collapse=deferred(),calls=[],navigations=[];
 let location={pathname:'/chat/agent/first',search:'',key:'first-route'},signal;
 let sessions=['first','second'].map((id,index)=>({session:{id,config:{name:id},origin:{type:'user'},created_at:`2026-10-16T0${2-index}:00:00Z`}}));
 const row={isConnected:true,nextElementSibling:{},parentElement:{},getBoundingClientRect:()=>({height:32}),
  animate:(frames,options)=>{calls.push({frames,options});return{finished:collapse.promise,cancel:()=>collapse.resolve()};}};
 const h=harness({'date-fns':{format:()=> '10:00'},'react-router-dom':{useLocation:()=>location,useNavigate:()=>path=>navigations.push(path)},
  '@/hooks/useAgents':{useAgents:()=>({agents:[{id:'agent',data:{name:'Covey'}}]})},
  '@/hooks/useSessions':{useSessions:()=>({sessions,remove:async(_id,beforeRefresh)=>{calls.push('delete');await saved.promise;if(fail)throw Error('offline');sessions=sessions.slice(1);await beforeRefresh();},refetch:async()=>{},update:async()=>{}})},
  '@/lib/messageSand':{messageMotionEnabled:()=>true,dissolveMessage:async(_row,abort)=>{signal=abort;calls.push('sand');await Promise.race([sand.promise,new Promise(resolve=>abort.addEventListener('abort',resolve,{once:true}))]);}}},
 {getComputedStyle:()=>({rowGap:'4px'})});
 const {SessionListSection}=h.load('components/layout/SessionListSection.tsx');
 const render=()=>h.render(SessionListSection);
 const sessionRow=tree=>find(tree,node=>node.props?.['data-session-delete']==='first');
 const start=()=>{
  let tree=render();sessionRow(tree).props.ref(row);
  find(sessionRow(tree),node=>node.props?.variant==='destructive').props.onClick();tree=render();
  return find(tree,node=>node.type==='DeleteDialog').props.onConfirm();
 };
 return {h,start,render,sessionRow,saved,sand,collapse,calls,navigations,get signal(){return signal;},move(){location={pathname:'/chat/agent/second',search:'',key:'second-route'};render();}};
}

test('导航删除复用沙粒，刷新期间保留条目，按实际间距补位后才跳转',async()=>{
 const f=sessionSandFixture(),removing=f.start();assert.deepEqual(f.calls,['delete']);
 f.saved.resolve();await tick();assert.deepEqual(f.calls,['delete','sand']);
 assert.ok(f.sessionRow(f.render()),'共享缓存已刷新也保留动画条目');
 assert.equal(f.navigations.length,0);f.sand.resolve();await tick();
 const collapse=f.calls[2];assert.equal(collapse.options.duration,300);assert.equal(collapse.frames[1].marginBottom,'-4px');
 f.collapse.resolve();await removing;assert.equal(f.sessionRow(f.render()),null);assert.deepEqual(f.navigations,['/chat/agent']);f.h.dispose();
});

test('导航删除失败不播放粒子；动画期间切换对话会取消且不抢走新页面',async()=>{
 const failed=sessionSandFixture({fail:true}),request=failed.start();failed.saved.resolve();await request;
 assert.deepEqual(failed.calls,['delete']);assert.ok(failed.sessionRow(failed.render()));assert.equal(failed.navigations.length,0);failed.h.dispose();
 const moving=sessionSandFixture(),removing=moving.start();moving.saved.resolve();await tick();moving.move();await removing;
 assert.equal(moving.signal.aborted,true);assert.deepEqual(moving.calls,['delete','sand']);assert.equal(moving.navigations.length,0);moving.h.dispose();
});

test('沙粒采样保留原像素颜色，800ms 从左到右释放，每粒 1000ms 消失',()=>{
 const h=harness();const {sampleSand,sandPose,SAND_COUNT}=h.load('lib/messageSand.ts');
 const pixels=new Uint8ClampedArray(40*10*4);
 for(let y=0;y<10;y++)for(let x=20;x<40;x++){const i=(y*40+x)*4;pixels.set([x<30?255:0,0,x<30?0:255,255],i);}
 const grains=sampleSand(pixels,40,10,400,100,()=>.5);
 assert.equal(grains.length,SAND_COUNT);assert.equal(SAND_COUNT,1500);
 assert.ok(grains.some(p=>p.color==='rgb(255,0,0)'));assert.ok(grains.some(p=>p.color==='rgb(0,0,255)'));
 const left=grains.reduce((a,b)=>a.x<b.x?a:b),right=grains.reduce((a,b)=>a.x>b.x?a:b);
 assert.equal(left.delay,0,'右对齐气泡从自身左缘开始，不先等待空白区域');assert.equal(right.delay,800);
 assert.equal(sandPose(right,799),null);assert.ok(sandPose(right,800));
 const start=sandPose(left,0),half=sandPose(left,500);assert.ok(half.x>start.x);assert.ok(half.y<start.y);assert.ok(half.alpha<start.alpha);assert.ok(half.size<start.size);
 assert.equal(sandPose(left,1000),null);assert.equal(sandPose(right,1800),null);
 assert.equal(sampleSand(new Uint8ClampedArray(16),2,2,20,20,()=>.5).length,0);
 h.dispose();
});

test('删除保存成功后保留气泡到动画结束；失败或切换会话不误删',async()=>{
 let session='one',fail=false;const animation=deferred(),writes=[];
 const h=harness({'@/api':{takeFreshlyCreated:()=>false,sessionApi:{messages:async()=>({messages:[{id:session+'-message',role:'user',content:[],created_at:'2026-10-13'}],is_running:false}),async *streamEvents(){},deleteMessage:async(...args)=>{writes.push(args);if(fail)throw Error('offline');}},chatApi:{}}});
 const {useMessages}=h.load('hooks/useMessages.ts');const render=()=>h.render(()=>useMessages('agent',session));
 render();await tick();let state=render();
 let started=false;const deleting=state.deleteMessage('one-message',()=>{started=true;return animation.promise;});await tick();assert.ok(started);assert.equal(render().msgs.length,1);
 animation.resolve();await deleting;assert.equal(render().msgs.length,0);assert.equal(writes[0][0],'one');
 session='two';render();await tick();state=render();fail=true;
 await assert.rejects(state.deleteMessage('two-message',async()=>{throw Error('must not animate');}),/offline/);assert.equal(render().msgs[0].id,'two-message');
 fail=false;const late=deferred();const moving=state.deleteMessage('two-message',()=>late.promise);await tick();session='three';render();await tick();late.resolve();await moving;assert.equal(render().msgs[0].id,'three-message');h.dispose();
});

test('网页删除事务进行中暂停发送，沙化期间继续发送不会复活已删气泡', {skip:!existsSync(new URL('../website/tochat/src/useWebConversation.ts',import.meta.url))},async()=>{
 const original={id:'deleted',role:'user',content:[{type:'text',text:'old'}],finished_at:'old'};
 let active={id:'web-delete',owner:'fixture',title:'saved title',mode:'chat',model:'fixture',messages:[original],wire:[{role:'user',content:'old'}]};
 const write=deferred(),animation=deferred(),saved=[];let requests=0;
 const h=harness({
  '@agentscope-ai/agentscope/event':{ReplyFinishedReason:{COMPLETED:'completed',ERROR:'error'}},'./i18n.ts':{webText:value=>value},
  './api':{webFetch:async()=>{requests++;return {};},webJSON:async()=>({title:null})},
  './storage':{saveConversation:async value=>saved.push(structuredClone(value)),deleteConversationMessage:()=>write.promise,applyConversationTitle:async()=>null},
  './stream':{readChatStream:async()=>({content:'new reply',reasoning:'',tools:[]})},
 },{structuredClone});
 const{useWebConversation}=h.load('../../../../website/tochat/src/useWebConversation.ts');
 const options={mode:'chat',model:'fixture',effort:'high',search:false,confirmWrites:true,onUpdate:value=>{active=value;},onQuota(){}};
 const render=()=>h.render(()=>useWebConversation('fixture',active,options));render();let state=render();
 const deleting=state.deleteMessage('deleted',()=>animation.promise);await tick();state=render();assert.equal(state.deletionSaving,true);
 await state.send([{type:'text',text:'wait'}]);assert.equal(requests,0);
 write.resolve({...active,messages:[],updated:1});await tick();state=render();assert.equal(state.deletionSaving,false);assert.equal(state.msgs.length,1,'keep the outgoing bubble until the animation completes');
 await state.send([{type:'text',text:'next'}]);assert.equal(requests,1);assert.ok(saved.length);assert.ok(saved.every(value=>value.messages.every(message=>message.id!=='deleted')));
 animation.resolve();await deleting;state=render();assert.equal(state.msgs.length,2);assert.ok(state.msgs.every(message=>message.id!=='deleted'));assert.equal(active.title,'saved title');h.dispose();
});

test('思考等待状态属于 AI：首事件前独立占位，空回复承接，正文到达立即移除',()=>{
 const h=harness({
  '@/hooks/useSkills':{useSkills:()=>({skills:[]})},
  './SlashCommandMenu':{commandsToSlashItems:()=>[],fromLibrary:()=>[]},
  './useChatAutoScroll':{useChatAutoScroll:()=>({})},
  '@agentscope-ai/agentscope/message':{getContentBlocks:()=>[]},
  '@agentscope-ai/agentscope/event':{ReplyFinishedReason:{EXCEED_MAX_ITERS:'exceed'}},
 });
 const {ChatContent}=h.load('components/chat/ChatContent.tsx');
 const user={id:'user',role:'user',created_at:'2026-10-17T00:00:00Z',content:[{type:'text',text:'hello'}]};
 const assistant={id:'assistant',role:'assistant',created_at:user.created_at,content:[]};
 const render=(msgs,phase='streaming')=>h.render(()=>ChatContent({msgs,phase,onSend(){},onUserConfirm(){}}));
 const pending=tree=>find(tree,node=>node.type==='AssistantThinkingMessage');
 const bubble=(tree,id)=>find(find(tree,node=>node.type==='DeletableMessage'&&node.props.id===id).props.children(null),node=>node.type==='ASMessageBubble');
 let tree=render([user]);assert.ok(pending(tree));assert.equal(bubble(tree,'user').props.showThinking,false);
 tree=render([user,assistant]);assert.equal(pending(tree),null);assert.equal(bubble(tree,'assistant').props.showThinking,true);
 tree=render([user,{...assistant,content:[{type:'text',text:'answer'}]}]);assert.equal(pending(tree),null);assert.equal(bubble(tree,'assistant').props.showThinking,false);
 assert.equal(pending(render([user],'idle')),null);
 h.dispose();
 const b=harness();const {AssistantThinkingMessage}=b.load('components/chat/ASMessageBubble.tsx');
 const placeholder=b.render(()=>AssistantThinkingMessage());assert.equal(placeholder.props.align,'start');assert.equal(placeholder.props['data-role'],'assistant');b.dispose();
});

test('消息操作：生成中隐藏，完成后与用户消息统一悬停显示，删除在复制左侧',()=>{
 const h=harness({'@agentscope-ai/agentscope/event':{ReplyFinishedReason:{ERROR:'error'}},'./tool-renderers/_shared':{collectChangedFiles:()=>[]}});const {ASMessageBubble}=h.load('components/chat/ASMessageBubble.tsx');
 const remove={type:'delete-button',props:{}};
 const base={id:'reply',name:'Tora',metadata:{},role:'assistant',created_at:'2026-10-13T12:00:00Z',content:[{id:'text',type:'text',text:'complete answer'}]};
 const render=(message,isGenerating=false)=>h.render(()=>ASMessageBubble({message,deleteAction:remove,isGenerating,showTimestamp:true,skillLibrary:[],onUserConfirm(){}}));
 const actions=tree=>find(tree,node=>node.props?.className==='message-actions');
 assert.equal(actions(render(base)),null,'No partial reply actions');
 const finished={...base,finished_at:'2026-10-13T12:00:01Z'};
 assert.equal(actions(render(finished,true)),null,'An active continuation must not reuse a stale completion marker');
 let toolbar=actions(render(finished));assert.equal(toolbar.props['data-visibility'],'hover');assert.equal(toolbar.props.dir,'ltr');assert.equal(toolbar.props.children[0],remove);assert.equal(toolbar.props.children[1].props.text,'complete answer');
 assert.equal(find(render(finished,true),node=>node.props?.className==='message-timestamp pointer-events-none'),null);
 assert.equal(find(render(finished),node=>node.props?.className==='message-timestamp pointer-events-none').props['data-visibility'],'hover');
 assert.equal(find(render({...base,role:'user'}),node=>node.props?.className==='message-timestamp pointer-events-none').props['data-visibility'],'hover');
 toolbar=actions(render({...base,role:'user'}));assert.equal(toolbar.props['data-visibility'],'hover');assert.equal(toolbar.props.children[0],remove);
 h.dispose();
});
