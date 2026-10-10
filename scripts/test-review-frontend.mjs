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
  const slots = [], effects = [], layouts = [];
  let cursor = 0;
  const changed = (a, b) => !a || !b || a.length !== b.length || a.some((v, i) => !Object.is(v, b[i]));
  const effect = queue => (fn, deps) => {
    const i = cursor++; if (changed(slots[i]?.deps, deps)) { queue.push(() => { slots[i]?.cleanup?.(); slots[i] = { deps, cleanup: fn() }; }); }
  };
  const react = {
    useState(initial) { const i = cursor++; if (!(i in slots)) slots[i] = typeof initial === 'function' ? initial() : initial; return [slots[i], value => { slots[i] = typeof value === 'function' ? value(slots[i]) : value; }]; },
    useId() { const i = cursor++; return slots[i] ??= `fixture-${i}`; },
    useRef(initial) { const i = cursor++; return slots[i] ??= { current: initial }; },
    useMemo(fn, deps) { const i = cursor++; if (changed(slots[i]?.deps, deps)) slots[i] = { deps, value: fn() }; return slots[i].value; },
    useCallback(fn, deps) { return react.useMemo(() => fn, deps); },
    useEffect: effect(effects), useLayoutEffect: effect(layouts), useImperativeHandle() {},
    lazy: () => 'Lazy', memo: fn => fn, forwardRef: fn => fn, createContext: value => ({ Provider: 'Provider', value }), useContext: ctx => ctx.value,
  };
  const jsx = (type, props) => ({ type, props });
  const window = { addEventListener() {}, removeEventListener() {}, dispatchEvent() {}, setTimeout: () => 1, clearTimeout() {}, setInterval: () => 1, clearInterval() {} };
  const audio = { disposeAll() {} };
  const imports = {
    './adapters/authStore': {getToken:()=> 'fixture-web-token'},
    '@/i18n': {__esModule:true,default:{language:'zh'}},
    react: { ...react, default: react }, 'react/jsx-runtime': { jsx, jsxs: jsx, Fragment: 'Fragment' },
    '@/i18n/useI18n': { useTranslation: () => ({ t: key => key, i18n: { language: 'zh' } }) },
    '@/i18n/useI18n.ts': { useTranslation: () => ({ t: key => key, i18n: { language: 'zh' } }) },
    '@/context/AudioContext': { useAudioManager: () => audio, AudioProvider: 'AudioProvider' },
    '@/lib/utils': { cn: (...values) => values.filter(Boolean).join(' ') },
    '@/lib/catgirl': { useCatgirlSettings: () => ({ installed: false, enabled: false }), catgirlTrigger: () => null, catgirlCopy: () => ({}) },
    '@agentscope-ai/agentscope/event': { EventType: new Proxy({}, { get: (_, key) => key }) },
    '@agentscope-ai/agentscope/message': { UserMsg: data => ({ id: randomUUID(), role: 'user', ...data }), AssistantMsg: data => ({ id: randomUUID(), role: 'assistant', ...data }), appendEvent() {} },
    mime: { getType: () => 'image/png', getExtension: () => 'png' },
    ...mocks,
  };
  const context = { console, performance, crypto: { randomUUID }, Response, Request, Headers, AbortController, AbortSignal, URL, URLSearchParams,
    window, document: { visibilityState: 'visible' }, localStorage: { getItem: () => null },
    setTimeout: () => 1, clearTimeout() {}, setInterval: () => 1, clearInterval() {},
    requestAnimationFrame: fn => { queueMicrotask(fn); return 1; }, cancelAnimationFrame() {},
    fetch: async () => { throw Error('Unexpected fetch'); }, ...globals };
  function load(path, append = '') {
    const source = readFileSync(new URL(path, base), 'utf8') + append;
    const output = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
    const exports = {};
    vm.runInNewContext(output, { ...context, exports, require: name => imports[name] ?? (name === '@/lib/tochatModels' ? load('lib/tochatModels.ts') : name.endsWith('/chat-media.js') ? load('../../../core/src/chat-media.js') : name === '@/lib/chatAttachments' ? load('lib/chatAttachments.ts') : name.endsWith('/session-mode.js') ? load('../../../core/src/session-mode.js') : name.endsWith('/builtin-models.js') ? load('../../../core/src/builtin-models.js') : name.endsWith('/title-rules.js') ? load('../../../core/src/title-rules.js') : undefined) ?? new Proxy({}, { get: (_, key) => key === '__esModule' ? true : String(key) }) }, { filename: path });
    return exports;
  }
  const flushEffects=()=>{for(const run of effects.splice(0))run();};
  return { load, render(fn,{deferEffects=false}={}) { cursor = 0; const result = fn(); for (const run of layouts.splice(0)) run(); if(!deferEffects)flushEffects(); return result; }, flushEffects,
    dispose() { for (const slot of slots) slot?.cleanup?.(); }, context };
}
function find(tree, predicate) {
  if (!tree) return null;
  if (Array.isArray(tree)) { for (const child of tree) { const found = find(child, predicate); if (found) return found; } return null; }
  if (typeof tree !== 'object') return null;
  return predicate(tree) ? tree : find(tree.props?.children, predicate);
}

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
    '@/hooks/useAgents': { useAgents: () => ({ agents: [{ id: 'agent' }] }) },
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
      '@/hooks/useAgents':{useAgents:()=>({agents:[{id:'agent'}]})},
      '@/hooks/useSessions':{useSessions:()=>({sessions:[{session:{id:'new-session',title:'新任务会话',updated_at:'2026-10-03',origin:{type:'user'},config:{application_mode:mode==='tochat'?'tochat':'tocode'}}}],refetch(){},update(){},remove(){}})},
      '@/lib/projectNaming':{projectKey:()=>null},
    };
    const h = harness(mocks);
    const {AppSidebar} = h.load('components/layout/AppSidebar.tsx');
    assert.equal(find(h.render(()=>AppSidebar({navigationMotion:'off'})),node=>node.props?.['data-testid']==='new-conversation').props.isActive,true);
    pathname += '/new-session';
    assert.equal(find(h.render(()=>AppSidebar({navigationMotion:'off'})),node=>node.props?.['data-testid']==='new-conversation').props.isActive,false);
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
    const tree = h.render(()=>AppSidebar({navigationMotion:'off'}));
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
      '@/hooks/useAgents':{useAgents:()=>({agents:[{id:'agent'}]})},
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
    '@/hooks/useAgents':{useAgents:()=>({agents:[{id:'agent'}]})},
    '@/hooks/useSessions':{useSessions:()=>({sessions:[{session:{id:'session',state:{permission_context:{mode:'default'}},config:{application_mode:'tochat',task_mode:'work',model_source:'custom',chat_model_config:{model:'fixture'}}}}],loading:false,refetch:async()=>{}})},
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

test('内置 Gemini 新会话保存所选模型，旧会话继续 DeepSeek，切换保留思考设置',async()=>{
  let params={agentId:'agent'},extras;
  const sessions=[{session:{id:'legacy',state:{},config:{application_mode:'tochat',model_source:'official',chat_model_config:{model:'deepseek-flash',parameters:{thinkingEffort:'max'}}}}}];
  const h=harness({
    'react-router-dom':{useNavigate:()=>()=>{},useParams:()=>params,useSearchParams:()=>[new URLSearchParams()]},
    '@/hooks/useAgents':{useAgents:()=>({agents:[{id:'agent'}]})},
    '@/hooks/useSessions':{useSessions:()=>({sessions,loading:false,refetch:async()=>{}})},
    '@/hooks/useMessages':{useMessages:(_agent,_session,options)=>{extras=options.newSessionExtras;return {msgs:[],loading:false,phase:'idle'};}},
    '@/hooks/useMotionSettings':{useMotionSettings:()=>({effective:'off',clickEnabled:false})},
    '@/lib/applicationModes':{readToChatSource:()=> 'official',modeCopy:()=>key=>key},
    '@/utils/authStore':{getToken:()=> 'synthetic-token'},
    '@/utils/modelSync':{cloudApi:()=> 'https://synthetic.invalid',cloudFetch:async()=>Response.json({enabled:true,chatRemaining:150,models:[{id:'deepseek-flash',enabled:true},{id:'gemini-3.8-flash',enabled:true}]})},
    'framer-motion':{motion:{span:'span'}},
  },{fetch:async()=>Response.json({})});
  const {ToChatConversation}=h.load('pages/tochat/index.tsx','\nexport {ToChatConversation};');
  const render=()=>h.render(()=>ToChatConversation());let tree=render();await tick();tree=render();
  const menu=find(tree,node=>node.type==='ChatContent').props.modelControl;
  await menu.props.onModel('gemini-3.8-flash');
  tree=render();assert.equal(extras().chat_model_config.model,'gemini-3.8-flash');
  await find(tree,node=>node.type==='ChatContent').props.modelControl.props.onEffort('medium');render();assert.equal(extras().chat_model_config.parameters.thinkingEffort,'medium');
  params={agentId:'agent',sessionId:'legacy'};render();assert.equal(extras().chat_model_config.model,'deepseek-flash');assert.equal(extras().chat_model_config.parameters.thinkingEffort,'max');
  params={agentId:'agent'};render();assert.equal(extras().chat_model_config.model,'gemini-3.8-flash');h.dispose();
});


test('自定义 Gemini 保存 medium 后选择器仍显示 medium',()=>{
 const h=harness();const {thinkingLevelOf}=h.load('components/select/LlmSelect.tsx','\nexport {thinkingLevelOf};');
 assert.equal(thinkingLevelOf({thinking:true,thinkingEffort:'medium'}),'medium');h.dispose();
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

test('ToCode picker offers model-specific built-in efforts and keeps custom mode separate',()=>{
 const h=harness({'@/hooks/useAvailableModels':{useAvailableModels:()=>({groups:{tora_official:[{credential:{id:'tora-official',data:{type:'tora_official',source:'builtin-models',name:'Tora'}},models:[{name:'gpt-6.1-sol',input_types:['text','image/png'],context_size:300000}]}]},loading:false,refetch(){},builtinQuota:{enabled:true,remainingPercent: 100, canUseAgent: true, subscription: {planId:'plus',name:'Tora Plus',expiresAt:'2099-01-01T00:00:00Z'}, windows: [{key:'fiveHour',remainingPercent:100,resetAt:null}], workDailyRemaining:900000,workWeeklyRemaining:9500000}})}});
 const {LlmSelect}=h.load('components/select/LlmSelect.tsx');const props={value:{type:'tora_official',credential_id:'tora-official',model:'gpt-6.1-sol',parameters:{thinking:true,thinkingEffort:'xhigh'}}};
 const tree=h.render(()=>LlmSelect(props));const submenu=find(tree,node=>node.type?.name==='SubmenuRow'&&node.props.label==='llm-select.thinking');assert.equal(find(tree,node=>node.type==='select'),null);assert.equal(find(tree,node=>node.type==='button'&&node.props.children==='llm-select.contextWindow'),null);assert.equal(submenu.props.current,'xhigh');assert.deepEqual(Array.from(submenu.props.options,option=>option.value),['low','medium','high','xhigh','max']);
 const hidden=h.render(()=>LlmSelect({...props,includeBuiltin:false}));assert.equal(find(hidden,node=>node.type?.name==='SubmenuRow'&&node.props.label==='llm-select.thinking'),null);assert.ok(find(hidden,node=>node.type==='p'&&node.props.children==='llm-select.empty.description'));h.dispose();
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
  const h=harness({'@/hooks/useAvailableModels':{useAvailableModels:()=>({groups:{tora_official:[{credential:{id:'tora-official',data:{type:'tora_official'}},models:[{name:'gpt-6-sol'}]}]},loading:false,builtinUnavailable:unavailable,refetch(){reloads++;}})}},{document:{visibilityState:'visible',addEventListener(){},removeEventListener(){}}});
  const{LlmSelect}=h.load('components/select/LlmSelect.tsx');let tree=h.render(()=>LlmSelect({}));
  find(tree,node=>node.type==='Popover').props.onOpenChange(true);assert.equal(reloads,unavailable?1:0,'opening a healthy menu must not add network traffic');
  tree=h.render(()=>LlmSelect({}));const model=find(tree,node=>node.type==='button'&&find(node,child=>child.type==='span'&&child.props.children==='GPT-6 Sol'));
  assert.equal(model.props.disabled,unavailable);
  const retry=find(tree,node=>node.type==='button'&&node.props.children==='error.retry');assert.equal(!!retry,unavailable);
  if(retry){retry.props.onClick();assert.equal(reloads,2);}h.dispose();
 }
});

test('live quota recovery repopulates a cached failed official group without losing custom models',()=>{
 const cached={tora_official:[{credential:{id:'tora-official',data:{type:'tora_official'}},models:[{name:'gpt-6-sol'},{name:'gemini-3.8-flash'}],unavailable:true}],custom:[{credential:{id:'personal',data:{type:'custom'}},models:[{name:'personal-model'}]}]};
 let live={isError:true,data:undefined,refetch(){}};
 const h=harness({'@tanstack/react-query':{useQuery:options=>options.queryKey[0]==='available-models'?{data:cached,isPending:false,error:null,refetch(){}}:live},'@/lib/query-client':{queryClient:{invalidateQueries(){}}}});
 const{useAvailableModels}=h.load('hooks/useAvailableModels.ts');const render=()=>h.render(()=>useAvailableModels());
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
  '@/hooks/useAgents':{useAgents:()=>({agents:[{id:'agent'}]})},
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

test('Doubao appears only in chat model menus; attachment capabilities include audio/video only there',()=>{
 const id='doubao-seed-2-1-lite-260915',h=harness();
 const {OfficialModelSelect}=h.load('components/select/OfficialModelSelect.tsx');
 const render=mode=>h.render(()=>OfficialModelSelect({model:'deepseek-flash',effort:'high',mode,onModel(){},onEffort(){}}));
 assert.ok(find(render('chat'),node=>node.type==='DropdownMenuRadioItem'&&node.props.value===id));
 assert.equal(find(render('work'),node=>node.type==='DropdownMenuRadioItem'&&node.props.value===id),null);
 const {chatAttachmentTypes}=h.load('lib/chatAttachments.ts');assert.ok(chatAttachmentTypes(id,'chat').includes('audio/wav'));assert.ok(chatAttachmentTypes(id,'chat').includes('video/mp4'));assert.ok(!chatAttachmentTypes(id,'work').includes('video/mp4'));assert.ok(!chatAttachmentTypes('gpt-6-sol','chat').includes('audio/wav'));h.dispose();
 const code=harness({'@/hooks/useAvailableModels':{useAvailableModels:()=>({groups:{tora_official:[{credential:{id:'tora-official',data:{type:'tora_official'}},models:[{name:id,input_types:['text']},{name:'gpt-6-sol',input_types:['text']}]}]},loading:false,refetch(){}})}});
 const {LlmSelect}=code.load('components/select/LlmSelect.tsx');const tree=code.render(()=>LlmSelect({}));assert.equal(find(tree,node=>node.type==='button'&&find(node,child=>child.props?.children==='Doubao Seed 2.1 Lite')),null);code.dispose();
});


test('retired developer settings and invalid external links fall back to General',()=>{
 const h=harness();const {normalizeSettingsSection,SETTINGS_SECTIONS}=h.load('lib/openSettings.ts');
 assert.ok(!SETTINGS_SECTIONS.includes('developer'));
 for(const value of ['developer',null,'',42,{}])assert.equal(normalizeSettingsSection(value),'general');
 for(const value of ['quota','model','agent','usage'])assert.equal(normalizeSettingsSection(value),value);
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
  const nav=[],h=harness({'date-fns':{format:()=>''},'react-router-dom':{useLocation:()=>({pathname,search}),useNavigate:()=>url=>nav.push(url)},'@/hooks/useAgents':{useAgents:()=>({agents:[{id:'agent'}]})},'@/hooks/useSessions':{useSessions:()=>({sessions:rows,refetch(){},update(){},remove(){}})}});
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
