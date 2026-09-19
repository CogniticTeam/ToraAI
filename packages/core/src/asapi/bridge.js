// ASAPI 聊天桥：POST /chat/ 触发后台运行，runAgent 事件流 → AgentEvent SSE 协议
// 关键语义（与前端 useMessages/appendEvent 对齐）：
//  - REPLY_START 按 reply_id 建 Msg；REPLY_END 收尾；运行结束清空缓冲，
//    避免历史接口已含该回复时重放导致内容翻倍。
//  - 运行中重连（刷新页面）：重放缓冲事件可无损重建进行中的回复。
//  - **HITL**：权限询问（REQUIRE_USER_CONFIRM）会让本轮暂停等待用户回复；
//    回复经 POST /chat/（input.type = USER_CONFIRM_RESULT）由 resolveConfirm()
//    路由到挂起的 resolver。等待期间会把当前回复快照写进 display，
//    这样刷新页面仍能看到确认卡片并作答。
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { runAgent } from '../agent.js';
import { loadConfig, saveConfig, VEGA_DIR } from '../config.js';
import { getCredential, loadSessionRecord, saveSessionRecord } from './store.js';
import { E, userMsg, assistantMsgShell, askingToolCall } from './protocol.js';
import { recordUsage } from './usage-store.js';
import { calcCredits } from '../credit-rates.js';
import { generateTitle, placeholderTitle } from '../title.js';
import { distillAfterRun } from './memory-distill.js';

/** 每个会话一个 bus：running 时含事件缓冲与订阅者 */
const buses = new Map();

function getBus(sessionId) {
  let bus = buses.get(sessionId);
  if (!bus) {
    bus = {
      running: false, replyId: null, events: [], subs: new Set(), ac: null,
      // HITL：tool_call_id -> resolver
      pending: new Map(),
      // AskUserQuestion：ask_id -> resolver（answer 事件按 id 唤醒）
      questions: new Map(),
      // 子代理 HITL：`${worker_session_id}:${reply_id}` -> { entry, finish }
      // team 工具里 worker 的权限确认登记在队长的 bus 上，
      // 由 resolveConfirm 的子代理分支按 tool_call id 转发唤醒。
      subagentPending: new Map(),
      // 等待确认期间写入 display 的快照（用于刷新后仍能看到卡片）
      parked: false
    };
    buses.set(sessionId, bus);
  }
  return bus;
}

function push(bus, event) {
  bus.events.push(event);
  for (const send of bus.subs) {
    try { send(event); } catch { /* 订阅者已断开 */ }
  }
}

export function isRunning(sessionId) {
  const b = buses.get(sessionId);
  return !!b?.running;
}

/** 该会话是否正在等用户确认（前端可用于显示提示） */
export function isAwaitingConfirm(sessionId) {
  const b = buses.get(sessionId);
  return !!b?.running && b.pending.size > 0;
}

// ---------- 子代理 HITL / team 通知（供 tools/team.js 使用） ----------

/**
 * 向"已存在的"会话 bus 推一条 CUSTOM 事件：team 工具广播 team_updated、
 * runWorker 投影 worker 确认事件（subagent_require_user_confirm /
 * subagent_user_confirm_result）都走这里。bus 不存在（CLI 批量跑、
 * 队长未运行）时静默跳过——这些通知只对在线视图有意义。
 */
export function pushCustomToLeaderBus(leaderSessionId, name, value) {
  const bus = buses.get(leaderSessionId);
  if (!bus) return false;
  push(bus, E.custom(name, value ?? {}));
  return true;
}

/**
 * 在队长 bus 上登记一个 worker 的挂起确认（子代理 HITL 的前半程）。
 * entry 即前端 SubagentHitlEntry（SubagentHitlCard 原样消费）；
 * finish 由 resolveConfirm 的子代理分支喂入 {confirmed, rules}。
 * 队长 bus 不存在或不在运行（AgentRun 必然运行在队长 run 内，理论上
 * 不会发生）时返回 false，调用方按"无确认通道"降级处理。
 */
export function registerSubagentConfirm(leaderSessionId, entry, finish) {
  const bus = buses.get(leaderSessionId);
  if (!bus?.running || !entry?.worker_session_id || !entry?.reply_id) return false;
  bus.subagentPending.set(`${entry.worker_session_id}:${entry.reply_id}`, { entry, finish });
  return true;
}

/**
 * 清掉队长 bus 上某 worker（workerSessionId 传空 = 全部）仍未作答的确认：
 * 按拒绝唤醒 resolver 并推 subagent_user_confirm_result 清卡。
 * runWorker 的 finally、队长 interrupt 与 run 收尾都会调用——防止
 * "幽灵卡片"挂在界面上（点开能答，但对应 resolver 已经死了）。
 */
export function cancelSubagentConfirms(leaderSessionId, workerSessionId, reason) {
  const bus = buses.get(leaderSessionId);
  if (!bus?.subagentPending?.size) return;
  for (const [key, rec] of [...bus.subagentPending]) {
    if (workerSessionId && rec.entry.worker_session_id !== workerSessionId) continue;
    bus.subagentPending.delete(key);
    try { rec.finish({ confirmed: false, error: reason || 'cancelled' }); } catch { /* ignore */ }
    push(bus, E.custom('subagent_user_confirm_result', {
      worker_session_id: rec.entry.worker_session_id,
      reply_id: rec.entry.reply_id
    }));
  }
}

/** 解析会话模型配置 → vega cfg（自接入：凭证 base_url/api_key + 会话级 model） */
export function resolveRunCfg(session, agent) {
  const vegaCfg = loadConfig();
  const mc = session.config?.chat_model_config || {};
  let baseURL = vegaCfg.baseURL;
  let apiKey = vegaCfg.apiKey;
  let visionOverride;
  let officialModel = false;
  if (mc.credential_id) {
    const cred = getCredential(mc.credential_id);
    if (cred?.data?.base_url) {
      baseURL = cred.data.base_url;
      if (cred?.data?.api_key) apiKey = cred.data.api_key;
    } else {
      // 合成凭证（cocode-models，来自设置窗口模型列表）：按选中模型名解析
      const hit = (vegaCfg.modelList || []).find((x) => x.enabled && x.model === mc.model);
      if (hit) {
        baseURL = hit.baseURL; apiKey = hit.apiKey;
        // 条目上的显式能力位（vision true/false）覆盖全局推断
        if (typeof hit.vision === 'boolean') visionOverride = hit.vision;
        // 官方模型标记：数据面走 auth-worker 计费网关（baseURL 已指向它），
        // 自定义模型永不为 true，不参与积分。带到 cfg 供事件/统计使用。
        if (hit.isOfficial) officialModel = true;
      }
    }
  }
  const cfg = {
    ...vegaCfg,
    baseURL,
    apiKey,
    model: mc.model || vegaCfg.model,
    temperature: mc.parameters?.temperature ?? vegaCfg.temperature,
    // 深度思考：默认开启（显式 false 才关）；thinkingEffort 为强度档（low/medium/high）
    thinking: mc.parameters?.thinking !== false,
    thinkingEffort: typeof mc.parameters?.thinkingEffort === 'string' ? mc.parameters.thinkingEffort : undefined
  };
  if (visionOverride !== undefined) cfg.vision = visionOverride;
  cfg.isOfficial = officialModel;
  if (agent?.data?.system_prompt) cfg.systemPrompt = agent.data.system_prompt;
  if (agent?.data?.context_config?.tool_result_limit) cfg.toolOutputLimit = agent.data.context_config.tool_result_limit;
  if (agent?.data?.react_config?.max_iters) cfg.maxTurns = agent.data.react_config.max_iters;
  return cfg;
}

/**
 * 加载额外工具：让 skill / 项目可以真的"带工具进来"。
 * 约定：`<工作目录>/.cocode/tools/*.js` 与 `~/.vega/tools/*.js`，
 * 每个模块 default export 一个工具或工具数组：
 *   { name, description, parameters, execute(args, ctx) }
 * 这是 agent.js 里 extraTools 参数的落地入口（原先 bridge 从不传，形同虚设）。
 */
export async function loadExtraTools(cwd) {
  const dirs = [join(VEGA_DIR, 'tools')];
  if (cwd) dirs.unshift(join(cwd, '.cocode', 'tools'));
  const tools = [];
  for (const dir of dirs) {
    let files;
    try { files = readdirSync(dir); } catch { continue; }
    for (const f of files.sort()) {
      if (!/\.m?js$/.test(f)) continue;
      try {
        const url = `${pathToFileURL(join(dir, f)).href}?v=${Date.now()}`;
        const mod = await import(url);
        const val = mod.default ?? mod.tools ?? null;
        for (const t of Array.isArray(val) ? val : [val]) {
          if (t && typeof t.name === 'string' && typeof t.execute === 'function') tools.push(t);
        }
      } catch { /* 单个工具坏了不该影响整轮 */ }
    }
  }
  return tools;
}

const CHUNK = 8000; // 单个 SSE 帧的工具结果分片大小
const blkId = () => `blk-${Math.random().toString(36).slice(2, 10)}`;

/**
 * 启动一次聊天运行（后台执行，事件通过 bus 广播）。
 *
 * ``payload.userText`` 是用户实际输入的文本，进 ``display`` 也进 ``internal``。
 * ``payload.contextText`` 是"隐身上下文"文本，仅合入 ``internal``（给 LLM 用），
 * 不进 ``display``，让用户气泡保持纯净。
 *
 * @param {string} sessionId
 * @param {object} agent
 * @param {string | {userText:string, contextText?:string, selected_skill_ids?:string[], images?:Array}} payload
 * @returns {{replyId}|{error}}
 */
/**
 * 同步壳：忙/不存在两类错误必须同步返回（HTTP 层靠它回 409），
 * 不能因为取名前置而变成 Promise。真正的流程在 _startChatRunAsync。
 */
export function startChatRun(sessionId, agent, payload) {
  const bus = getBus(sessionId);
  if (bus.running) return { error: '会话正在运行中，请稍候或先中止' };
  const session = loadSessionRecord(sessionId);
  if (!session) return { error: '会话不存在' };
  _startChatRunAsync(sessionId, agent, payload).catch((e) => {
    // 取名/落盘等前置步骤失败：广播 error 事件而不是静默吞掉；
    // 同时复位运行态，避免 _runImpl 启动前抛错时该会话永久卡在"运行中"，
    // 后续所有请求都会命中 409。_finishRun 若已跑过，此处赋值是幂等无副作用。
    bus.running = false;
    bus.replyId = null;
    push(bus, E.replyEnd(sessionId, `reply-err-${Date.now().toString(36)}`, 'error', { type: 'internal', message: e?.message || String(e) }));
  });
  return {};
}

async function _startChatRunAsync(sessionId, agent, payload) {
  const bus = getBus(sessionId);
  const session = loadSessionRecord(sessionId);
  if (!session || bus.running) return; // 壳已校验；此处兜底

  // 兼容两种入参：旧代码 / 旧测试可能传纯字符串；新代码传对象。
  const userText = typeof payload === 'string' ? payload : (payload?.userText ?? '');
  const contextText = typeof payload === 'string' ? '' : (payload?.contextText ?? '');
  const images = typeof payload === 'string' ? [] : (Array.isArray(payload?.images) ? payload.images : []);
  const selectedSkillIds =
    typeof payload === 'string' ? [] : (Array.isArray(payload?.selected_skill_ids) ? payload.selected_skill_ids : []);

  const replyId = `reply-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  bus.replyId = replyId;
  bus.running = true;
  bus.pending = new Map();
  bus.subagentPending = new Map();
  bus.parked = false;
  bus.userText = userText; // 供诊断/展示用（首轮取名已前移到 startChatRun）

  // 立即入历史（刷新页面也可见）。
  // - internal：隐式上下文（若有）拼在用户文本之前；这是 LLM 真正看到的全量上下文。
  // - display：只放用户文本，保持用户视角气泡纯净——隐式上下文完全不可见。
  const internalContent = contextText ? `${contextText}\n\n${userText}` : userText;
  session.internal.push({
    role: 'user',
    content: images.length
      ? [
          { type: 'text', text: internalContent },
          ...images.map((im) => ({ type: 'image_url', image_url: { url: im.data_url ?? im.url } }))
        ]
      : internalContent
  });
  session.display.push(
    userMsg(
      userText,
      selectedSkillIds.length > 0 ? { selected_skill_ids: selectedSkillIds } : undefined,
      // 图片以 data block 形态存 display：刷新页面后附件气泡仍在，
      // 形态与前端 UserMsg 的 ContentBlock 完全一致。
      images.map((im) => ({
        id: `img-${Math.random().toString(36).slice(2, 10)}`,
        type: 'data',
        source: {
          type: 'url',
          url: im.data_url ?? im.url,
          media_type: im.media_type ?? 'image/png',
        },
        name: im.name ?? 'image',
        created_at: new Date().toISOString(),
      })),
    ),
  );
  // AI 自动命名（仅首轮）：**先开工、后台取名**。首轮立即以占位标题启动
  // Agent（REPLY_START 毫秒级到达，用户零等待），AI 标题在后台生成 ——
  // 成功后改名、落盘并广播 session_updated，侧栏实时刷新为最终名字；
  // 失败/超时静默保留占位标题（generateTitle 自带 20s 超时兜底）。
  // 无论成败都锁 naming.auto=false —— 仅第一次，后续轮次零额外请求。
  const firstRun = session.config.naming?.auto !== false;
  const cfg = resolveRunCfg(session, agent);
  if (firstRun) {
    session.config.naming = { auto: false };
    const ph = placeholderTitle(userText);
    if (!session.config.name || session.config.name === ph) {
      session.config.name = session.config.name || ph;
      saveSessionRecord(session);
      generateTitle(cfg, { userText })
        .then((t) => {
          if (!t) return;
          session.config.name = t;
          saveSessionRecord(session);
          for (const send of bus.subs) { try { send(E.custom('session_updated', {})); } catch { /* ignore */ } }
        })
        .catch(() => { /* 保留占位标题 */ });
    } else {
      saveSessionRecord(session);
    }
  }

  // 本次运行的 display 块由事件流增量构建（见 _runImpl）。不能在收尾时
  // 从 session.internal 反推：上下文自动压缩会 splice 掉中段历史，按索
  // 引切片会错位，按 run 标记筛选又会丢掉已被摘要的那部分。
  const replyBlocks = [];
  // 本条回复累计消耗的积分：官方模型逐轮按 usage 以与网关一致的口径累计
  // （逐次调用取整再求和，与实际扣费完全对齐），结束时写进消息 metadata。
  const credits = { used: 0 };

  _runImpl(sessionId, session, cfg, bus, replyId, replyBlocks, credits)
    .catch((e) => {
      push(bus, E.replyEnd(sessionId, replyId, 'error', { type: 'internal', message: e?.message || String(e) }));
    })
    .finally(() => _finishRun(session, bus, sessionId, replyId, replyBlocks, cfg, credits));

  return { replyId };
}

/**
 * 把当前 replyBlocks 快照写入 display（按 reply_id upsert）。
 * 等待用户确认时用它 —— 否则刷新页面会因为"回复还没结束"而看不到确认卡片。
 */
function syncReplyDisplay(session, replyId, replyBlocks) {
  const msg = assistantMsgShell(replyId);
  msg.content = replyBlocks;
  msg.finished_at = null;
  const idx = session.display.findIndex((m) => m.id === replyId);
  if (idx >= 0) session.display[idx] = msg;
  else session.display.push(msg);
  try { saveSessionRecord(session); } catch { /* ignore */ }
}

async function _runImpl(sessionId, session, cfg, bus, replyId, replyBlocks, credits) {
  push(bus, E.replyStart(sessionId, replyId, 'assistant'));
  const ac = new AbortController();
  bus.ac = ac;

  let textOpen = null;
  let thinkingOpen = null;      // 当前打开的 thinking block id
  let modelOpen = false;    // 本轮模型调用是否已发 MODEL_CALL_START
  let doneReason = null, doneError = null;
  let inputTokens = 0, outputTokens = 0;

  const ts = () => new Date().toISOString();
  // 关闭当前 text block：把它固化进 replyBlocks（供持久化 display 用），
  // 同时向前端发 TEXT_BLOCK_END。
  const closeText = () => {
    if (!textOpen) return;
    push(bus, E.textBlockEnd(replyId, textOpen));
    const blk = replyBlocks.find((b) => b.type === 'text' && b.id === textOpen);
    if (blk) blk.finished_at = ts();
    textOpen = null;
  };
  // 关闭当前 thinking block：与 closeText 同一套簿记（固化 + END 事件）
  const closeThinking = () => {
    if (!thinkingOpen) return;
    push(bus, E.thinkingBlockEnd(replyId, thinkingOpen));
    const blk = replyBlocks.find((b) => b.type === 'thinking' && b.id === thinkingOpen);
    if (blk) blk.finished_at = ts();
    thinkingOpen = null;
  };
  const openModel = () => { if (!modelOpen) { push(bus, E.modelCallStart(replyId, cfg.model)); modelOpen = true; } };
  const closeModel = () => { if (modelOpen) { push(bus, E.modelCallEnd(replyId, inputTokens, outputTokens)); modelOpen = false; } };

  // ---- HITL：权限询问 ----
  // agent.js 在 ask 处 await 这里的 Promise；用户回复经 resolveConfirm() 送达。
  //
  // **这里只登记 resolver，绝不推事件。**
  //
  // 原因：本函数是被 agent 在自己的执行流里同步调用的，而事件是由下面那个
  // for-await 消费循环按顺序推给前端的。若在此直接 push，确认事件会"插队"到
  // 还排在 channel 队列里的 checkpoint / tool-start 之前 —— 前端 appendEvent
  // 处理 REQUIRE_USER_CONFIRM 时找不到对应 tool_call 块（SDK 是 `if (b)` 静默
  // 跳过），结果是**卡片不出现、工具调用永远停在 pending**，只有重新进入会话
  // 从 display 快照里读到 asking 块才看得到卡片。事件统一在 case 'require-confirm'
  // 里发，顺序才有保证。
  //
  // 时序上这是安全的：agent.js 先 emit('require-confirm') 再同步调用本函数，
  // 所以消费循环处理到该事件时 bus.pending 一定已经登记好了。
  const permissionAsk = ({ id }) =>
    new Promise((resolve) => {
      const finish = (answer) => {
        if (!bus.pending.has(id)) return;
        bus.pending.delete(id);
        resolve(answer);
      };
      bus.pending.set(id, finish);
      bus.parked = true;

      // 中止时按拒绝处理，保证 run 能收尾
      const onAbort = () => finish({ confirmed: false, error: 'aborted' });
      if (ac.signal.aborted) onAbort();
      else ac.signal.addEventListener('abort', onAbort, { once: true });
    });

  // AskUserQuestion 通道：与 permissionAsk 同一时序契约 —— agent 侧先经
  // payload.emit 把 'ask-user' 事件排进队列（消费循环在 case 'ask-user'
  // 里推给前端，顺序有保证），随后本函数登记 resolver 并 await。
  // 答案由 resolveQuestion() 从 /chat/ 入口送进来。
  const askUser = ({ questions, emit }) =>
    new Promise((resolve) => {
      const id = `ask_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
      const finish = (answer) => {
        if (!bus.questions.has(id)) return;
        bus.questions.delete(id);
        bus.parked = bus.pending.size > 0;
        resolve(answer || { cancelled: true });
      };
      bus.questions.set(id, finish);
      bus.parked = true;
      emit({ type: 'ask-user', id, questions: Array.isArray(questions) ? questions : [] });

      const onAbort = () => finish({ cancelled: true, error: 'aborted' });
      if (ac.signal.aborted) onAbort();
      else ac.signal.addEventListener('abort', onAbort, { once: true });
    });

  const rules = Array.isArray(cfg.permissionRules) ? cfg.permissionRules : [];
  const onRuleAdded = (rule) => {
    try {
      const next = [...(loadConfig().permissionRules || []), rule];
      saveConfig({ permissionRules: next });
      push(bus, E.custom('permission_rule_added', { rule }));
    } catch { /* ignore */ }
  };

  try {
    // 工作目录从 session.config.cwd 取；为 null 也启动 runAgent（让对话正常进行），
    // 工具执行处会自行检查 cwd==null 并返回提示——避免 process.cwd() 兜底成
    // CoCode 包根目录。Electron 进程的 cwd 永远不是合法会话工作目录。
    const sessionCwd = session.config?.cwd || null;
    const extraTools = await loadExtraTools(sessionCwd);

    for await (const e of runAgent({
      cfg,
      cwd: sessionCwd,
      messages: session.internal,
      signal: ac.signal,
      extraTools,
      sessionId,
      permissionAsk,
      askUser,
      permissionRules: rules,
      onRuleAdded,
      // 会话状态通道：任务工具族（TaskCreate/Update/Get/List）经它读写
      // state.tasks_context。写 = 落盘 + state_updated SSE，计划面板实时刷新。
      sessionState: {
        read: () => loadSessionRecord(sessionId)?.state ?? {},
        write: (patch) => {
          const s = loadSessionRecord(sessionId);
          if (!s) return;
          s.state = { ...(s.state ?? {}), ...patch };
          saveSessionRecord(s);
          push(bus, E.custom('state_updated', patch));
        }
      },
      checkpoint: {
        enabled: cfg.checkpointEnabled !== false,
        sessionId,
        keepTurns: cfg.checkpointKeepTurns
      },
      // 权限模式由 session.state.permission_mode 决定。读 permission_context.mode
      // 是为了旧会话（mode 平铺在 permission_context.mode 而不是 state）兼容。
      permissionMode: session.state?.permission_mode
        ?? session.state?.permission_context?.mode
        ?? 'bypass',
      // 电脑控制（Computer）会话级同意：agent.gate 对 Computer 特判 ——
      // 未确认时强制弹一次确认卡（不受权限模式影响），确认后写入
      // session.state.computer_confirmed 落盘持久；本会话后续 Computer
      // 调用（含子代理）直接放行。
      computerConsent: {
        granted: !!session.state?.computer_confirmed,
        onGranted() {
          const s = loadSessionRecord(sessionId);
          if (!s) return;
          s.state = { ...(s.state ?? {}), computer_confirmed: true };
          saveSessionRecord(s);
        }
      },
    })) {
      switch (e.type) {
        case 'text-delta':
          openModel();
          closeThinking();
          if (!textOpen) {
            textOpen = blkId();
            replyBlocks.push({ type: 'text', id: textOpen, text: '', created_at: ts(), finished_at: null });
            push(bus, E.textBlockStart(replyId, textOpen));
          }
          {
            const blk = replyBlocks.find((b) => b.id === textOpen);
            if (blk) blk.text += e.text;
          }
          push(bus, E.textBlockDelta(replyId, textOpen, e.text));
          break;
        case 'thinking-delta':
          // 深度思考流：reasoning_content 增量（DeepSeek/Qwen 等约定字段）
          openModel();
          if (!thinkingOpen) {
            thinkingOpen = blkId();
            replyBlocks.push({ type: 'thinking', id: thinkingOpen, thinking: '', created_at: ts(), finished_at: null });
            push(bus, E.thinkingBlockStart(replyId, thinkingOpen));
          }
          {
            const blk = replyBlocks.find((b) => b.type === 'thinking' && b.id === thinkingOpen);
            if (blk) blk.thinking += e.text;
          }
          push(bus, E.thinkingBlockDelta(replyId, thinkingOpen, e.text));
          break;
        case 'tool-start': {
          closeText();
  closeThinking();
          const input = JSON.stringify(e.args ?? {});
          const block = {
            type: 'tool_call', id: e.id, name: e.name,
            input, state: 'finished', created_at: ts(), finished_at: ts()
          };
          const prev = replyBlocks.findIndex((b) => b.type === 'tool_call' && b.id === e.id);
          if (prev >= 0) replyBlocks[prev] = block; else replyBlocks.push(block);
          push(bus, E.toolCallStart(replyId, e.id, e.name));
          if (input) push(bus, E.toolCallDelta(replyId, e.id, input));
          push(bus, E.toolCallEnd(replyId, e.id));
          break;
        }
        case 'tool-result': {
          const text = String(e.result ?? '');
          const block = {
            type: 'tool_result', id: e.id, name: e.name,
            output: [{ type: 'text', id: blkId(), text, created_at: ts(), finished_at: ts() }],
            state: e.ok ? 'success' : 'error',
            // duration_ms 之外合并工具自带的结构化元数据（Write/Edit 的
            // {diff,added,removed}）—— 前端靠 metadata.diff 渲染 diff 卡片
            // 和头部 +N/-M 徽标。
            metadata: { duration_ms: e.durationMs, ...(e.meta && typeof e.meta === 'object' ? e.meta : {}) },
            created_at: ts(), finished_at: ts()
          };
          const prev = replyBlocks.findIndex((b) => b.type === 'tool_result' && b.id === e.id);
          if (prev >= 0) replyBlocks[prev] = block; else replyBlocks.push(block);
          try { recordUsage({ toolName: e.name }); } catch { /* ignore */ }
          push(bus, E.toolResultStart(replyId, e.id, e.name));
          for (let i = 0; i < text.length; i += CHUNK) {
            push(bus, E.toolResultTextDelta(replyId, e.id, text.slice(i, i + CHUNK)));
          }
          push(bus, E.toolResultEnd(replyId, e.id, e.ok ? 'success' : 'error', { duration_ms: e.durationMs }));
          break;
        }
        case 'ask-user': {
          // AskUserQuestion：把问题面板数据推给前端（浮层渲染，不进消息流）。
          // 重放安全：前端按 id 去重；bus.questions 里还有该 id 说明仍在等待。
          push(bus, E.custom('user_question_requested', {
            ask_id: e.id,
            reply_id: replyId,
            questions: e.questions
          }));
          break;
        }
        case 'require-confirm': {
          // 确认卡片在这里发 —— 走到这一步说明排在它前面的 checkpoint / tool-start
          // 都已经推给前端了，tool_call 块一定存在，appendEvent 才能把块翻成 asking。
          const id = e.id;
          const block = askingToolCall({ id, name: e.name, args: e.args, suggestedRules: e.suggestedRules });
          const prev = replyBlocks.findIndex((b) => b.type === 'tool_call' && b.id === id);
          if (prev >= 0) replyBlocks[prev] = block; else replyBlocks.push(block);

          push(bus, E.requireUserConfirm(replyId, [
            askingToolCall({ id, name: e.name, args: e.args, suggestedRules: e.suggestedRules })
          ]));
          push(bus, E.custom('permission_requested', {
            tool_call_id: id, tool_name: e.name, category: e.reason ?? null
          }));

          // 落一份快照，刷新页面后仍能看到卡片并作答
          syncReplyDisplay(session, replyId, replyBlocks);
          break;
        }
        case 'confirm-resolved': {
          // 用户已作答：翻牌 replyBlocks 里的块（语义与 SDK appendEvent 一致）。
          // 不翻的话落盘 display 里该块永远是 asking —— 刷新/重启后"已答复"
          // 的卡片会复活成可点状态，再作答就撞 409。
          const blk = replyBlocks.find((b) => b.type === 'tool_call' && b.id === e.id);
          if (blk && blk.state === 'asking') blk.state = e.confirmed ? 'allowed' : 'finished';
          // 更新快照，让刷新后的状态与实时一致
          if (bus.parked) syncReplyDisplay(session, replyId, replyBlocks);
          break;
        }
        case 'checkpoint':
          push(bus, E.custom('checkpoint_created', {
            turn: e.turn, fileCount: e.fileCount, bytes: e.bytes,
            hint: `已保存第 ${e.turn} 轮检查点（改动前快照），需要时可以回滚`
          }));
          break;
        case 'mode-changed':
          push(bus, E.custom('model_mode_changed', { mode: e.mode, reason: e.reason }));
          break;
        case 'hook':
          // 钩子的执行结果对用户可见 —— 尤其"检测到项目钩子但未信任"这种安全提示，
          // 静默跳过等于让用户以为钩子生效了。
          push(bus, E.custom('hook_result', {
            event: e.event,
            tool: e.tool || null,
            ran: e.ran ?? 0,
            decision: e.decision || null,
            reason: e.reason || '',
            notices: e.notices || [],
            errors: e.errors || [],
            context: e.context || ''
          }));
          break;
        case 'turn-end':
          closeText();
          closeThinking();
          if (e.usage) { inputTokens += e.usage.prompt_tokens || 0; outputTokens += e.usage.completion_tokens || 0; }
          // 官方模型网关在流结束时按 usage 扣积分——此刻扣费刚落账，按同口径
          // 累计本条回复的消耗并广播（携带累计值，前端实时展示在气泡上）；
          // 自定义模型不扣积分，跳过。模式口径与 model.js 的 X-CoCode-Mode 一致。
          if (cfg.isOfficial && e.usage) {
            const mode = String(cfg.mode || '').toLowerCase() === 'ask' ? 'ask' : 'craft';
            const creditDelta = calcCredits(cfg.model, e.usage, mode);
            credits.used += creditDelta;
            // 累计值用于回复气泡；本轮增量用于前端立刻扣减侧栏余额，
            // 避免等待下一次 /auth/me 请求才看到数值变化。
            push(bus, E.custom('credits_changed', {
              credits: credits.used,
              credit_delta: creditDelta,
            }));
          }
          openModel(); // 纯工具轮兜底：补发 START 再 END，保证 usage 归属
          closeModel();
          break;
        case 'compact':
          // 低 token 治理：把"压缩已发生"作为可见事件广播，让前端在
          // 对话流里插一条轻提示（旧实现完全静默，用户不知道历史被压缩）。
          push(bus, E.custom('context_compacted', {
            evicted: e.evicted,
            compacted: !!e.compacted,
            tokensBefore: e.tokensBefore,
            tokensAfter: e.tokensAfter,
            budget: e.budget
          }));
          break;
        case 'done':
          doneReason = e.reason;
          if (e.reason === 'blocked') {
            // 钩子在 UserPromptSubmit 拦下了整轮：模型一个字都没输出，
            // 但用户必须知道发生了什么，否则界面看起来像"卡住了"。
            closeText();
  closeThinking();
            const bid = blkId();
            const text = `⛔ 本轮被钩子拦下：${e.message || '（钩子未说明原因）'}`;
            replyBlocks.push({ type: 'text', id: bid, text, created_at: ts(), finished_at: ts() });
            push(bus, E.textBlockStart(replyId, bid));
            push(bus, E.textBlockDelta(replyId, bid, text));
            push(bus, E.textBlockEnd(replyId, bid));
          }
          break;
        case 'error':
          doneReason = 'error';
          doneError = { type: 'internal', message: e.error };
          break;
      }
      if (doneReason) break;
    }
  } catch (e) {
    if (!doneReason) { doneReason = 'error'; doneError = { type: 'internal', message: e?.message || String(e) }; }
  }
  // 收尾时把还挂着的确认请求按拒绝收掉，避免 resolver 泄漏
  for (const [, finish] of bus.pending) finish({ confirmed: false, error: 'run-ended' });
  bus.pending.clear();
  // 挂起的 AskUserQuestion 同理：按取消收掉，前端面板随之收起
  for (const [, finish] of bus.questions) finish({ cancelled: true, error: 'run-ended' });
  bus.questions.clear();
  // 挂起的子代理确认：正常路径由 runWorker 的 finally 清掉，这里是兜底
  // （worker run 意外卡住等）——按拒绝收掉并推事件清卡，不留幽灵卡片。
  cancelSubagentConfirms(sessionId, null, 'run-ended');

  // 作废仍处于 asking 的确认卡片（中止/出错/收尾竞态都会走到这）：不失效
  // 的话卡片继续挂在界面上可点，作答会得到"没有等待中的确认请求"。
  // 广播 confirm_invalidated 让在线前端立即翻牌；持久化 display 由
  // _finishRun 用这里的 replyBlocks 落盘。
  const staleAskIds = replyBlocks
    .filter((b) => b.type === 'tool_call' && b.state === 'asking')
    .map((b) => b.id);
  if (staleAskIds.length) {
    for (const b of replyBlocks) {
      if (b.type === 'tool_call' && b.state === 'asking') b.state = 'finished';
    }
    push(bus, E.custom('confirm_invalidated', { reply_id: replyId, tool_call_ids: staleAskIds }));
  }

  closeText();
  closeThinking();
  closeModel();
  // 用量持久化（使用统计的权威数据源，见 usage-store.js）
  if (inputTokens || outputTokens) {
    try { recordUsage({ tokens: inputTokens + outputTokens, runs: 1, model: cfg.model }); } catch { /* ignore */ }
  }

  // Memory 可选提炼（fire-and-forget）：只认"正常完成"的收尾，开关关闭时不发请求。
  // distillAfterRun 内部全静默（见 memory-distill.js），这里再兜一层 .catch。
  if (doneReason === 'completed') {
    const lastText = [...replyBlocks].reverse().find((b) => b.type === 'text')?.text || '';
    void distillAfterRun(cfg, {
      userText: bus.userText,
      assistantText: lastText,
      projectKey: session.config?.cwd || ''
    }).catch(() => {});
  }

  const reason = doneReason === 'completed' || doneReason === 'blocked' ? 'completed'
    : doneReason === 'aborted' ? 'interrupted'
    : doneReason === 'max-turns' ? 'exceed_max_iters'
    : 'error';
  push(bus, E.replyEnd(sessionId, replyId, reason, doneError));
}

function _finishRun(session, bus, sessionId, replyId, replyBlocks, cfg, credits) {
  // display 的 assistant Msg 直接用事件流增量构建好的块（与前端从同一
  // 事件流还原出来的视图同源）。不从 session.internal 反推，因为上下文
  // 自动压缩会在运行中 splice 掉中段历史，事后按索引或标记筛选都会错。
  if (replyBlocks.length) {
    const msg = assistantMsgShell(replyId);
    msg.content = replyBlocks;
    // 本条回复的积分消耗写进 metadata：刷新/重进会话后气泡底部仍能展示
    if (credits?.used > 0) msg.metadata.credits = credits.used;
    msg.finished_at = new Date().toISOString();
    delete msg.run_state;
    // 等待确认期间可能已经写过同 id 的快照 → upsert 而不是 push，否则会出现两条
    const idx = session.display.findIndex((m) => m.id === replyId);
    if (idx >= 0) session.display[idx] = msg;
    else session.display.push(msg);
  }
  // 落盘失败（磁盘满 / 权限 / 序列化）不能崩 finally 链、更不能卡住会话。
  // 记录错误继续走完清理，下次运行不受影响。
  try { saveSessionRecord(session); } catch (e) { console.error('[bridge] _finishRun 落盘失败:', e?.message || e); }

  // 通知前端会话有更新（侧栏自动命名等）
  for (const send of bus.subs) { try { send(E.custom('session_updated', {})); } catch { /* ignore */ } }

  // 结束：清理运行状态；保留订阅者供下次运行复用
  bus.running = false;
  bus.ac = null;
  bus.parked = false;
  for (const [, finish] of bus.pending) finish({ confirmed: false, error: 'run-ended' });
  bus.pending = new Map();
  // 子代理确认已由 _runImpl 收尾的 cancelSubagentConfirms 处理（finish
  // 幂等 + 清卡事件），这里只重置表，避免异常路径下残留跨轮泄漏。
  bus.subagentPending = new Map();
  // 挂起中的提问（run 被中止/出错时仍未作答）：按取消收掉并通知前端收面板
  if (bus.questions.size) {
    const askIds = [...bus.questions.keys()];
    for (const [, finish] of bus.questions) finish({ cancelled: true, error: 'run-ended' });
    bus.questions = new Map();
    for (const ask_id of askIds) push(bus, E.custom('user_question_cancelled', { ask_id }));
  }
  bus.events = []; // 清空缓冲：历史接口已含该回复，重放会翻倍
  bus.replyId = null;
  // 若已无订阅者，稍后回收 bus
  setTimeout(() => {
    if (bus.subs.size === 0 && !bus.running && buses.get(sessionId) === bus) buses.delete(sessionId);
  }, 30000);
}

/** SSE 订阅：运行中则重放缓冲事件，再实时推送。返回取消订阅函数。 */
export function subscribe(sessionId, send) {
  const bus = getBus(sessionId);
  for (const e of bus.events) send(e);
  bus.subs.add(send);
  return () => bus.subs.delete(send);
}

export function interrupt(sessionId) {
  const bus = buses.get(sessionId);
  if (!bus?.running) return false;
  // 有挂起的确认请求（会话被 park）：按拒绝唤醒，让 run 走完收尾流程
  if (bus.pending.size) {
    for (const [, finish] of bus.pending) finish({ confirmed: false, error: 'interrupted' });
    bus.pending.clear();
  }
  if (bus.questions.size) {
    for (const [, finish] of bus.questions) finish({ cancelled: true, error: 'interrupted' });
    bus.questions.clear();
  }
  // 子代理确认同样按拒绝唤醒：worker 的 permissionAsk 挂在队长 bus 上，
  // 不清的话 AgentRun 工具会永远 await，中止形同无效。
  cancelSubagentConfirms(sessionId, null, 'interrupted');
  if (bus.ac) { bus.ac.abort(); return true; }
  return true;
}

/**
 * 把持久化 display 中（指定 reply 或全部）asking 状态的 tool_call 块置为
 * finished，返回失效数量。用于"幽灵卡片"清理：
 *  - 服务重启后内存 bus 丢失，但 display 快照里还留着确认卡片；
 *  - run 结束/被中止后用户才迟迟作答。
 * 这些卡片已不可能被真正 resolve，留在界面上只会诱导用户作答后撞 409。
 * notify(replyId, ids) 可选：把失效广播给在线前端（SSE 订阅者）。
 */
function invalidateAskingBlocks(sessionId, replyId, notify) {
  try {
    const session = loadSessionRecord(sessionId);
    if (!session) return 0;
    const changed = [];
    for (const msg of session.display) {
      if (msg.role !== 'assistant' || !Array.isArray(msg.content)) continue;
      if (replyId && msg.id !== replyId) continue;
      for (const b of msg.content) {
        if (b && b.type === 'tool_call' && b.state === 'asking') {
          b.state = 'finished';
          changed.push({ reply_id: msg.id, ids: [b.id] });
        }
      }
    }
    if (changed.length) {
      saveSessionRecord(session);
      if (notify) for (const c of changed) notify(c.reply_id, c.ids);
    }
    return changed.length;
  } catch { return 0; }
}

/**
 * 处理用户的权限回复（前端把 UserConfirmResultEvent 作为 input POST 到 /chat/）。
 * 这是 HITL 链路的后半截：agent.js 在 permissionAsk 里 await，这里把结果送进去。
 *
 * @param {string} sessionId
 * @param {object} event  { reply_id, confirm_results: [{confirmed, tool_call:{id}, rules}] }
 * @returns {{resolved:number, stale:number, notRunning:boolean}}
 */
export function resolveConfirm(sessionId, event) {
  const bus = buses.get(sessionId);
  const results = Array.isArray(event?.confirm_results) ? event.confirm_results : [];
  if (!bus?.running) {
    // 迟到的答复（run 已结束/被中止，或服务重启后内存态丢失）：
    // 优雅降级 —— 把残留的确认卡片作废，而不是让用户撞一句硬错误。
    // bus 还在（重连窗口）时顺带广播，在线前端立即翻牌。
    invalidateAskingBlocks(
      sessionId,
      event?.reply_id ?? null,
      bus ? (rid, ids) => push(bus, E.custom('confirm_invalidated', { reply_id: rid, tool_call_ids: ids })) : null
    );
    return { resolved: 0, stale: results.length, notRunning: true };
  }
  let resolved = 0, stale = 0;
  for (const r of results) {
    const id = r?.tool_call?.id ?? r?.tool_call_id;
    // 子代理 HITL：team.js runWorker 把 worker 的确认登记在本 bus 的
    // subagentPending 上，前端把答复 POST 到队长 /chat/（reply_id 是
    // 子代理的）。按 tool_call id 命中登记项 → 唤醒 worker 的
    // permissionAsk，并推 subagent_user_confirm_result 清卡。
    if (id && bus.subagentPending.size) {
      let hit = null;
      for (const [key, rec] of bus.subagentPending) {
        if (rec.entry.event?.tool_calls?.some((t) => t?.id === id)) { hit = { key, rec }; break; }
      }
      if (hit) {
        bus.subagentPending.delete(hit.key);
        hit.rec.finish({ confirmed: !!r.confirmed, rules: Array.isArray(r.rules) ? r.rules : [] });
        push(bus, E.custom('subagent_user_confirm_result', {
          worker_session_id: hit.rec.entry.worker_session_id,
          reply_id: hit.rec.entry.reply_id
        }));
        resolved++;
        continue;
      }
    }
    const finish = id ? bus.pending.get(id) : null;
    if (!finish) { stale++; continue; }
    // 先把用户的答复回灌进事件流：前端 appendEvent 会把该 tool_call
    // 从 asking 翻成 allowed/finished，卡片立刻收起（多标签页/重连也一致）。
    push(bus, { ...event, reply_id: event?.reply_id ?? bus.replyId, confirm_results: [r] });
    finish({ confirmed: !!r.confirmed, rules: Array.isArray(r.rules) ? r.rules : [] });
    resolved++;
  }
  return { resolved, stale, notRunning: false };
}

/**
 * 处理用户对 AskUserQuestion 的作答（前端 POST /chat/，input.type =
 * 'USER_QUESTION_ANSWER'）。与 resolveConfirm 同一套迟到/失效处理：
 * run 已结束 → 返回 stale，前端静默收面板。
 *
 * @param {string} sessionId
 * @param {object} event { ask_id, answers: [{selected,other}], note?, cancelled? }
 */
export function resolveQuestion(sessionId, event) {
  const bus = buses.get(sessionId);
  const id = event?.ask_id;
  if (!bus?.running || !id || !bus.questions.has(id)) {
    return { resolved: 0, stale: 1, notRunning: !bus?.running };
  }
  const finish = bus.questions.get(id);
  // 答案回灌事件流：多标签页/重连场景下其他视图同步收起面板
  push(bus, E.custom('user_question_answered', { ask_id: id }));
  finish({
    answers: Array.isArray(event.answers) ? event.answers : [],
    note: typeof event.note === 'string' ? event.note : '',
    cancelled: !!event.cancelled
  });
  return { resolved: 1, stale: 0, notRunning: false };
}
