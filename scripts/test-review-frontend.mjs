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
  const context = { console, crypto: { randomUUID }, Response, Request, Headers, AbortController, AbortSignal, URL, URLSearchParams,
    window, document: { visibilityState: 'visible' }, localStorage: { getItem: () => null },
    setTimeout: () => 1, clearTimeout() {}, setInterval: () => 1, clearInterval() {},
    requestAnimationFrame: fn => { queueMicrotask(fn); return 1; }, cancelAnimationFrame() {},
    fetch: async () => { throw Error('Unexpected fetch'); }, ...globals };
  function load(path, append = '') {
    const source = readFileSync(new URL(path, base), 'utf8') + append;
    const output = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
    const exports = {};
    vm.runInNewContext(output, { ...context, exports, require: name => imports[name] ?? (name === '@/lib/tochatModels' ? load('lib/tochatModels.ts') : undefined) ?? new Proxy({}, { get: (_, key) => key === '__esModule' ? true : String(key) }) }, { filename: path });
    return exports;
  }
  return { load, render(fn) { cursor = 0; const result = fn(); for (const run of layouts.splice(0)) run(); for (const run of effects.splice(0)) run(); return result; },
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

function messagesFixture() {
  const creating = deferred(), history = deferred(), navigations = [], triggers = [], fresh = new Set();
  let agentId = 'agent', sessionId = null, delayedHistory = false;
  const options = { onSessionCreated: id => navigations.push(id) };
  const h = harness({ '@/api': {
    takeFreshlyCreated: id => fresh.delete(id),
    sessionApi: { create: () => creating.promise.then(res => { fresh.add(res.session_id); return res; }),
      messages: async id => delayedHistory && id === 'A' ? history.promise : { messages: [{ id: id + '-user', role: 'user', content: [] }], is_running: false },
      async *stream() {} },
    chatApi: { trigger: async value => { triggers.push(value); } },
  } });
  const { useMessages } = h.load('hooks/useMessages.ts');
  const render = () => h.render(() => useMessages(agentId, sessionId, options));
  return { h, render, creating, history, navigations, triggers,
    setSession(id) { sessionId = id; }, delayHistory() { delayedHistory = true; } };
}

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
 const h=harness({'@/api':{credentialApi:{list:async()=>({credentials:[{id:'personal',data:{type:'openai_compatible'}},{id:'tora-official',data:{type:'tora_official'}}]})},modelApi:{list:async type=>({models:(type==='tora_official'?['gpt-6.1-sol','gemini-3.8-flash','deepseek-flash']:['own-model']).map(name=>({name}))})}},'@/utils/modelSync':{syncBuiltinModelAuth:async()=>{},cloudFetch:async()=>online?Response.json(quota):Response.json({detail:'unavailable'},{status:503})}});
 const {fetchGroups}=h.load('hooks/useAvailableModels.ts','\nexport {fetchGroups};');let groups=await fetchGroups();assert.deepEqual(Array.from(groups.tora_official[0].models,model=>model.name),['deepseek-flash','gemini-3.8-flash']);assert.equal(groups.openai_compatible[0].models[0].name,'own-model');
 online=false;groups=await fetchGroups();assert.equal(groups.tora_official[0].models.length,0);assert.equal(groups.tora_official[0].unavailable,true);assert.equal(groups.openai_compatible[0].models[0].name,'own-model');h.dispose();
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
