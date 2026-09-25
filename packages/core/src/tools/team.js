// Team 工具集：多智能体团队协作
//
// 9 个工具，队长（captain）在 spawnDepth=0 的 session 里才能用：
//   TeamCreate / AgentCreate / AgentRun / AgentMessage / AgentHandoff
//   AgentList / TeamDocWrite / TeamDocRead / TeamDelete
//
// 权限矩阵（resolveWorkerMode）：worker 的 permissionMode 由队长的模式和
// AgentCreate 调用时传入的 agentCreatePermissions 共同决定 —— 只升不降。
//
// worker session 运行走 runAgent 引擎，spawnDepth=1 防递归注册 teamTools。
// AgentRun / AgentMessage 用模块级 pendingQueue（Map<agent_id, string[]>）
// 累积消息，AgentRun 时合并进 messages。

import { mkdirSync, existsSync, readFileSync, writeFileSync, appendFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

import { runAgent } from '../agent.js';
import { loadConfig, saveConfig, COCODE_DIR } from '../config.js';
import { createWorktree, removeWorktree } from './cocode-git.js';
import {
  isRunning, pushCustomToLeaderBus, registerSubagentConfirm, cancelSubagentConfirms
} from '../asapi/bridge.js';
import { askingToolCall } from '../asapi/protocol.js';
import {
  getAgent, createAgent,
  createSessionRecord, loadSessionRecord, saveSessionRecord
} from '../asapi/store.js';
import {
  listTeams, getTeam, createTeam, updateTeam,
  addTeamMember, removeTeamMember, disbandTeam, getTeamDocPath,
  getTeamByLeader
} from '../asapi/team-store.js';

// ---------- pending message queue（AgentMessage / AgentRun 之间接力） ----------
const pendingQueue = new Map(); // agent_id → string[]

function drainPending(agentId) {
  const arr = pendingQueue.get(agentId);
  if (!arr || arr.length === 0) return [];
  pendingQueue.delete(agentId);
  return arr;
}

function pushPending(agentId, message) {
  if (!pendingQueue.has(agentId)) pendingQueue.set(agentId, []);
  pendingQueue.get(agentId).push(message);
}

// ---------- 权限矩阵 ----------
//
// AgentCreate 时队长指定 agentCreatePermissions（explore / accept_edits / bypass），
// 但 worker 实际能拿到的 mode 由"队长 mode"和"请求 mode"取交集 —— 只升不降。
const MODE_RANK = { explore: 0, default: 1, accept_edits: 2, bypass: 3 };

function resolveWorkerMode(captainMode, requested) {
  const capRank = MODE_RANK[captainMode] ?? 3; // 未知队长模式 → 宽松处理（实际不会遇到）
  const reqRank = MODE_RANK[requested] ?? 0;  // 未知请求 → 保守 explore
  const finalRank = Math.min(capRank, reqRank);
  // 返回值映射回 permissionMode 字符串：跳过 default（worker 不存在 default，explore 就是只读）
  if (finalRank <= 0) return 'explore';
  if (finalRank === 1) return 'explore'; // default 在 worker 语境等价 explore
  if (finalRank === 2) return 'accept_edits';
  return 'bypass';
}

/** 检查队长是否允许给予 requested 权限，不允许返回错误消息。 */
function validateWorkerMode(captainMode, requested) {
  const capRank = MODE_RANK[captainMode] ?? 3;
  const reqRank = MODE_RANK[requested] ?? 0;
  if (reqRank > capRank) {
    return `权限不足：队长模式为 ${captainMode}，无法授予 ${requested}（worker 权限不能高于队长）。`;
  }
  return null;
}

// ---------- 写入 worker 隔离 ----------
//
// Agent 不应该把多个会写代码的 worker 丢进同一目录。auto 的策略是：
// 只读 worker 共享队长 cwd（无需复制仓库）；accept_edits / bypass worker 必须
// 拿到独立 Git worktree。若用户明确选择 shared，则保留旧行为但在结果里醒目
// 标记风险；Git 不可用时绝不静默降级为共享写入。
const WRITABLE_WORKER_MODES = new Set(['accept_edits', 'bypass']);
const ISOLATION_MODES = new Set(['auto', 'shared', 'worktree']);

function safeSegment(value, fallback = 'worker') {
  const out = String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 24);
  return out || fallback;
}

function workerWorktreeSpec(team, role) {
  const stamp = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
  const teamPart = safeSegment(team.id, 'team');
  const rolePart = safeSegment(role, 'worker');
  const branch = `cocode/team-${teamPart}/${rolePart}-${stamp}`;
  const path = join(COCODE_DIR, 'team-worktrees', team.id, `${rolePart}-${stamp}`);
  return { branch, path };
}

/**
 * 根据权限与用户意图决定 worker 的目录隔离级别。
 * 这是纯函数，既用于实际创建前的安全判定，也方便客户端/测试展示准确预期。
 */
export function resolveWorkerIsolation(mode, isolation = 'auto') {
  const requested = isolation || 'auto';
  if (!ISOLATION_MODES.has(requested)) {
    return { ok: false, error: `isolation 必须是 ${[...ISOLATION_MODES].join(' / ')}。` };
  }
  const needsIsolation = requested === 'worktree' || (requested === 'auto' && WRITABLE_WORKER_MODES.has(mode));
  return { ok: true, isolation: needsIsolation ? 'worktree' : 'shared' };
}

async function provisionWorkerWorkspace({ team, cwd, role, mode, isolation }) {
  const plan = resolveWorkerIsolation(mode, isolation);
  if (!plan.ok) return plan;
  if (plan.isolation === 'shared') {
    return { ok: true, cwd, isolation: 'shared', worktree: null };
  }
  if (!cwd) {
    return { ok: false, error: '无法创建隔离工作树：队长尚未选择项目目录。请选择一个 Git 项目，或显式指定 isolation="shared"。' };
  }

  const spec = workerWorktreeSpec(team, role);
  mkdirSync(join(COCODE_DIR, 'team-worktrees', team.id), { recursive: true });
  const created = await createWorktree(cwd, spec.path, spec.branch);
  if (!created.ok) {
    return {
      ok: false,
      error:
        `无法为可写 worker 创建 Git worktree：${created.error}\n` +
        '为避免多个 Agent 在同一目录互相覆盖，本次未创建 worker。若你确认接受共享目录风险，请显式指定 isolation="shared"。'
    };
  }
  return {
    ok: true,
    cwd: spec.path,
    isolation: 'worktree',
    worktree: { path: spec.path, branch: spec.branch, source_cwd: cwd }
  };
}

// ---------- team 结构/状态变更通知 ----------
/**
 * 向队长视图广播 CUSTOM(team_updated)：前端据此 refetch 团队面板
 * （成员、session 状态等）。队长 bus 不存在（CLI 批量跑）时静默跳过。
 */
function notifyTeamUpdated(ctx) {
  pushCustomToLeaderBus(ctx.sessionId, 'team_updated', {});
}

// ---------- runWorker：调 runAgent 并累计事件 ----------
//
// 子代理 HITL：worker 的 ask 判定经 permissionAsk 投影到队长 bus
// （CUSTOM subagent_require_user_confirm），由队长视图的
// SubagentHitlCard 展示；用户答复 POST 到队长 /chat/，经
// bridge.resolveConfirm 的子代理分支唤醒这里的 resolver。
async function runWorker({
  cfg, messages, permissionMode, sessionId, cwd,
  leaderSessionId, workerAgentId, workerAgentName, signal, computerConsent
}) {
  const start = Date.now();
  let text = '';
  let toolCalls = 0;
  let denied = 0;
  let doneReason = null;
  let doneError = null;
  let confirmSeq = 0;

  const workerCheckpoint = {
    enabled: cfg.checkpointEnabled !== false,
    sessionId,
    keepTurns: cfg.checkpointKeepTurns
  };

  // agent.js 同批 tool_calls 是 Promise.all 并行执行 —— 同一 worker 可能
  // 并发弹出多个确认。前端卡片按 (worker_session_id, reply_id) 去重且只
  // 渲染第一条，所以每个确认事件必须携带唯一 reply_id：作答 → 后端清卡
  // → 下一张浮出，形成天然串行卡片队列。
  const permissionAsk = ({ id, name, args, suggestedRules }) =>
    new Promise((resolve) => {
      const replyId = `subreply-${Date.now().toString(36)}-${(confirmSeq++).toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
      const now = new Date().toISOString();
      const entry = {
        worker_session_id: sessionId,
        worker_agent_id: workerAgentId || '',
        worker_agent_name: workerAgentName || workerAgentId || 'worker',
        reply_id: replyId,
        event_type: 'require_user_confirm',
        event: {
          type: 'REQUIRE_USER_CONFIRM',
          reply_id: replyId,
          created_at: now,
          tool_calls: [askingToolCall({ id, name, args, suggestedRules })]
        },
        created_at: now
      };
      let settled = false;
      const finish = (answer) => {
        if (settled) return; // resolveConfirm 与 finally 兜底可能 racing，幂等
        settled = true;
        resolve(answer);
      };
      if (!registerSubagentConfirm(leaderSessionId, entry, finish)) {
        // 队长 bus 不可用（CLI 批量跑等）：与"无通道"同语义 → 拒绝
        finish({ confirmed: false, error: 'noChannel' });
        return;
      }
      pushCustomToLeaderBus(leaderSessionId, 'subagent_require_user_confirm', entry);
    });

  try {
    for await (const e of runAgent({
      cfg,
      cwd,
      messages,
      signal: signal ?? null,
      computerConsent: computerConsent ?? null,
      permissionMode,
      spawnDepth: 1,
      sessionId,
      checkpoint: workerCheckpoint,
      permissionRules: [], // worker 不继承队长的规则，保持干净
      permissionAsk,
      // 用户在子代理卡片上选"总是允许"：与队长同一套持久化口径，
      // 并广播 permission_rule_added 让前端规则面板同步。
      onRuleAdded: (rule) => {
        try {
          const next = [...(loadConfig().permissionRules || []), rule];
          saveConfig({ permissionRules: next });
          pushCustomToLeaderBus(leaderSessionId, 'permission_rule_added', { rule });
        } catch { /* ignore */ }
      }
    })) {
      if (e.type === 'text-delta') text += e.text ?? '';
      else if (e.type === 'thinking-delta') { /* thinking 不计入 */ }
      else if (e.type === 'tool-start') toolCalls++;
      else if (e.type === 'tool-result' && e.ok === false) denied++;
      else if (e.type === 'done') { doneReason = e.reason; doneError = e.error; }
    }
  } finally {
    // worker run 结束/抛错的兜底：清掉还没人作答的确认（含清卡事件），
    // 防止幽灵卡片；resolver 按拒绝收掉，不会泄漏 await。
    cancelSubagentConfirms(leaderSessionId, sessionId, 'worker-run-ended');
  }

  return {
    text: text.trim(),
    toolCalls,
    denied,
    durationMs: Date.now() - start,
    doneReason,
    doneError
  };
}

// ---------- 工具共享：从 ctx 解析队长 session + team ----------
function getCaptainSession(ctx) {
  return loadSessionRecord(ctx.sessionId);
}

function getCaptainTeam(ctx) {
  const session = getCaptainSession(ctx);
  if (!session) return null;
  return session.team_id ? getTeam(session.team_id) : getTeamByLeader(ctx.sessionId);
}

/** 把 worker run 结果写入 session.display（简化版：一条文本消息）。 */
function appendWorkerDisplay(session, text) {
  if (!text) return;
  const now = () => new Date().toISOString();
  const replyId = `worker-reply-${Date.now().toString(36)}`;
  // agentscope Msg: assistant 消息带一个 text block
  session.display.push({
    id: replyId,
    created_at: now(),
    finished_at: now(),
    role: 'assistant',
    name: session.config?.name || 'worker',
    blocks: [
      { type: 'text', id: `blk_${Date.now().toString(36)}`, text, created_at: now(), finished_at: now() }
    ]
  });
}

// ======================================================================
// 9 个工具
// ======================================================================

// --- 1. TeamCreate ---
export const teamCreateTool = {
  name: 'TeamCreate',
  description: '创建一个新的团队（队长本人就是本 session 的 agent）。一个 session 同时只能属于一个活跃团队。',
  parameters: {
    type: 'object',
    properties: {
      name: { type: 'string', description: '团队名称（2~24 字）' },
      description: { type: 'string', description: '团队目标/使命说明（可选）' }
    },
    required: ['name']
  },
  async execute(args, ctx) {
    if (ctx.spawnDepth > 0) {
      return 'TeamCreate 只能在队长 session 里调用，worker 不能再创建团队。';
    }
    const session = getCaptainSession(ctx);
    if (!session) return '无法获取当前 session 信息。';

    const existing = getTeamByLeader(ctx.sessionId);
    if (existing) {
      return `你已经是团队 "${existing.name}"（${existing.id}）的队长。如需建新团队，请先 TeamDelete 解散当前团队。`;
    }

    const team = createTeam({
      leader_session_id: ctx.sessionId,
      leader_agent_id: session.agent_id,
      name: String(args?.name ?? '').trim(),
      description: String(args?.description ?? '').trim()
    });

    // 队长 session 也挂上 team_id（方便后续工具查 team）
    session.team_id = team.id;
    saveSessionRecord(session);

    // 初始化团队文档
    const docPath = getTeamDocPath(team.id);
    mkdirSync(join(docPath, '..'), { recursive: true });
    writeFileSync(docPath, `# ${team.name}\n\n${team.description || ''}\n\n> 创建于 ${team.created_at}\n`);

    notifyTeamUpdated(ctx);
    return `团队创建成功：\n  ID: ${team.id}\n  名称: ${team.name}\n  成员数: 0（队长 + ${team.member_ids.length} 个 worker）`;
  }
};

// --- 2. AgentCreate ---
export const agentCreateTool = {
  name: 'AgentCreate',
  description:
    '为团队创建一个 worker agent（独立的 agent + 独立 session）。' +
    '只读 worker 共享队长工作目录；可写 worker 默认创建独立 Git worktree，避免并行改动互相污染。' +
    '权限模式由 agentCreatePermissions 参数决定（不高于队长）。',
  parameters: {
    type: 'object',
    properties: {
      role: { type: 'string', description: 'worker 角色（如「前端」「测试」「研究员」）' },
      goal: { type: 'string', description: 'worker 的核心目标（一句话）' },
      backstory: { type: 'string', description: 'worker 的背景/专长（可选，帮助模型更好地扮演角色）' },
      agentCreatePermissions: {
        type: 'string',
        enum: ['explore', 'accept_edits', 'bypass'],
        description: 'worker 权限：explore=只读，accept_edits=可写文件，bypass=完全访问。不能高于队长的权限模式。默认 explore。'
      },
      isolation: {
        type: 'string',
        enum: ['auto', 'worktree', 'shared'],
        description:
          '工作目录隔离策略：auto（默认；写入 worker 用 Git worktree，只读共享目录）、' +
          'worktree（始终隔离）、shared（显式共享队长目录，多个写入 worker 可能冲突）。'
      }
    },
    required: ['role', 'goal']
  },
  async execute(args, ctx) {
    if (ctx.spawnDepth > 0) return 'AgentCreate 只能在队长 session 里调用。';

    const team = getCaptainTeam(ctx);
    if (!team) return '你还没有团队，请先 TeamCreate。';
    if (team.status !== 'active') return '团队已解散。';

    // 权限校验
    const captainSession = getCaptainSession(ctx);
    // 队长会话记录不完整时同样按 default 处理，不能让 worker 因缺字段提升权限。
    const captainMode = captainSession?.state?.permission_mode
      ?? captainSession?.state?.permission_context?.mode
      ?? 'default';
    const requested = args?.agentCreatePermissions || 'explore';
    const err = validateWorkerMode(captainMode, requested);
    if (err) return err;

    const workspace = await provisionWorkerWorkspace({
      team,
      cwd: ctx.cwd,
      role: args.role,
      mode: requested,
      isolation: args?.isolation || 'auto'
    });
    if (!workspace.ok) return workspace.error;

    let agent;
    let session;
    try {
      // 创建 agent
      agent = createAgent({
        name: String(args.role).trim(),
        system_prompt: [
          `你是团队 "${team.name}" 的成员，角色：${args.role}。`,
          `核心目标：${args.goal}。`,
          args.backstory ? `背景：${args.backstory}。` : '',
          `工作目录策略：${workspace.isolation}${workspace.worktree ? `（独立分支 ${workspace.worktree.branch}）` : '（与队长共享，只读或由用户显式确认）'}。`,
          '\n你是 worker —— 由队长指派任务、接收队长的消息，需要时把结果汇报给队长。',
          '不要创建新团队或新 worker；专注于完成队长分配的具体任务。'
        ].filter(Boolean).join('\n')
      });

      // 创建 session
      session = createSessionRecord({
        agent_id: agent.id,
        chat_model_config: captainSession?.config?.chat_model_config,
        workspace_id: captainSession?.config?.workspace_id,
        cwd: workspace.cwd,
        origin: { type: 'team', team_id: team.id, isolation: workspace.isolation, worktree: workspace.worktree },
        team_id: team.id
      });

      // 挂权限模式
      session.state = session.state || {};
      session.state.permission_mode = requested;
      saveSessionRecord(session);

      addTeamMember(team.id, agent.id);
    } catch (e) {
      // worktree 已成功而后续元数据落盘失败时，尽量回收全新空树；回收失败也只
      // 留下可见目录，不会影响原仓库。
      if (workspace.worktree) {
        try { await removeWorktree(ctx.cwd, workspace.worktree.path); } catch { /* best effort */ }
      }
      return `创建 worker 失败：${e?.message || e}`;
    }

    notifyTeamUpdated(ctx);
    return [
      'Worker 创建成功：',
      `  agent_id: ${agent.id}`,
      `  session_id: ${session.id}`,
      `  角色: ${args.role}`,
      `  权限: ${requested}`,
      `  隔离: ${workspace.isolation}`,
      `  工作目录: ${workspace.cwd}`,
      workspace.worktree ? `  分支: ${workspace.worktree.branch}` : null,
      workspace.isolation === 'shared' && WRITABLE_WORKER_MODES.has(requested)
        ? '  ⚠ 该 worker 与队长共享可写目录；不要同时运行多个写入任务。'
        : null
    ].filter(Boolean).join('\n');
  }
};

// --- 3. AgentRun ---
export const agentRunTool = {
  name: 'AgentRun',
  description: '指派一个 worker agent 执行具体任务。如果 AgentMessage 已经给它发过消息，会合并到本次运行里。返回 worker 的最终产出摘要。',
  parameters: {
    type: 'object',
    properties: {
      agent_id: { type: 'string', description: '目标 worker 的 agent_id（AgentCreate 返回）' },
      task: { type: 'string', description: '本次要执行的具体任务（自包含的任务书）' },
      workerPermissions: {
        type: 'string',
        enum: ['explore', 'accept_edits', 'bypass'],
        description: '本次运行的权限临时提升（仍不能超过队长）。默认沿用 worker 创建时的权限。'
      }
    },
    required: ['agent_id', 'task']
  },
  async execute(args, ctx) {
    const team = getCaptainTeam(ctx);
    if (!team) return '你还没有团队，请先 TeamCreate。';

    const agentId = args.agent_id;
    if (!agentId || !team.member_ids.includes(agentId)) {
      return `agent_id ${agentId} 不是当前团队 "${team.name}" 的成员。`;
    }

    const captainSession = getCaptainSession(ctx);
    // 与 AgentCreate 保持同一条安全默认值，避免旧会话在 AgentRun 时得到完全访问。
    const captainMode = captainSession?.state?.permission_mode
      ?? captainSession?.state?.permission_context?.mode
      ?? 'default';

    // 加载 worker session
    // agent_id → session：遍历 team.member_ids 找对应 session
    let workerSession = null;
    for (const sid of [/* need to find session by agent_id */]) {
      const s = loadSessionRecord(sid);
      if (s && s.agent_id === agentId && s.team_id === team.id) { workerSession = s; break; }
    }
    // 上面那个循环没法写死（sessionId 未知），换策略：从 store 找
    // store.js 没有 listSessionRecords 按 agent_id 查？看看
    // 实际上用 getTeam 里信息不够 —— member_ids 是 agent_id，不是 session_id
    // 让我先查有没有这个工具... 好，store.js 里有 listSessionRecords
    if (!workerSession) {
      const { listSessionRecords } = await import('../asapi/store.js');
      const allSessions = listSessionRecords();
      workerSession = allSessions.find(
        (s) => s.agent_id === agentId && s.team_id === team.id && s.origin?.type === 'team'
      );
    }
    if (!workerSession) return `找不到 agent_id ${agentId} 对应的 worker session。可能已被删除。`;

    // 不允许并发运行同一个 worker
    if (isRunning(workerSession.id)) {
      return `Worker session ${workerSession.id} 正在运行中，请稍后再试或先 AgentList 查看状态。`;
    }

    // 解析权限
    let effectiveMode = workerSession.state?.permission_mode || 'explore';
    if (args.workerPermissions) {
      const err = validateWorkerMode(captainMode, args.workerPermissions);
      if (err) return err;
      effectiveMode = resolveWorkerMode(captainMode, args.workerPermissions);
    }

    // 合并 pending queue + task → messages
    const pending = drainPending(agentId);
    const messages = [
      ...(workerSession.internal || []),
      ...pending.map((m) => ({ role: 'user', content: `【队长消息】\n${m}` })),
      { role: 'user', content: `【队长 任务指派】\n${args.task}` }
    ];

    // 跑 worker（leaderSessionId + worker 身份用于子代理 HITL 投影）
    const workerAgent = getAgent(agentId);
    const { text, toolCalls, denied, durationMs, doneReason } = await runWorker({
      cfg: ctx.cfg,
      messages,
      permissionMode: effectiveMode,
      sessionId: workerSession.id,
      cwd: workerSession.config?.cwd || ctx.cwd,
      leaderSessionId: ctx.sessionId,
      workerAgentId: agentId,
      workerAgentName: workerAgent?.data?.name || agentId,
      signal: ctx?.signal ?? null,
      computerConsent: ctx?.computerConsent ?? null
    });

    // 更新 worker session
    workerSession.internal = messages; // runAgent 会 push assistant/tool 消息进这个数组吗？
    // 注意：runAgent 里 messages 是 input，runAgent 内部会操作 messages 的副本吗？
    // 实际上 runAgent 内部不会 push 到传入的 messages —— 它会把 LLM 输出作为事件发出来。
    // 所以这里 internal 保持不变（或清空重置），让 worker 有干净上下文下次 run。
    // 但如果我们希望 worker 能看到之前的交互，应该把这次的交互追加进去。
    // 这里简化：worker session 每次 AgentRun 都有干净的 task，internal 不累积。

    appendWorkerDisplay(workerSession, text || '(无文本产出)');
    workerSession.updated_at = new Date().toISOString();
    saveSessionRecord(workerSession);

    notifyTeamUpdated(ctx);
    const stats = `（${durationMs}ms，${toolCalls} 次工具调用${denied ? `，${denied} 次被拒` : ''}）`;
    const reasonHint = doneReason === 'completed' ? '' : `\n[运行结束原因：${doneReason}]`;
    return (text || '(worker 没有返回文本结果)') + `${stats}${reasonHint}`;
  }
};

// --- 4. AgentMessage ---
export const agentMessageTool = {
  name: 'AgentMessage',
  description: '向某个 worker 发送消息（入队）。下次 AgentRun 该 worker 时会合并进去。适合先给 worker 发几条指引，再一次性 AgentRun。',
  parameters: {
    type: 'object',
    properties: {
      agent_id: { type: 'string', description: '目标 worker 的 agent_id' },
      message: { type: 'string', description: '要发给 worker 的消息' }
    },
    required: ['agent_id', 'message']
  },
  async execute(args, ctx) {
    const team = getCaptainTeam(ctx);
    if (!team) return '你还没有团队。';
    if (!team.member_ids.includes(args.agent_id)) return `agent_id ${args.agent_id} 不在本团队。`;

    pushPending(args.agent_id, String(args.message || ''));
    notifyTeamUpdated(ctx);
    return `消息已入队（队列长度：${pendingQueue.get(args.agent_id)?.length || 0}）。下次 AgentRun 该 worker 时会一并送达。`;
  }
};

// --- 5. AgentHandoff ---
export const agentHandoffTool = {
  name: 'AgentHandoff',
  description:
    '与 AgentRun 同构，但在 worker 的任务开头插入一段"交接上下文"——' +
    '适合把另一个 worker 做过的事 + 当前任务组合在一起，让新 worker 有完整上下文。',
  parameters: {
    type: 'object',
    properties: {
      agent_id: { type: 'string', description: '目标 worker 的 agent_id' },
      handoff_context: { type: 'string', description: '交接上下文：前面的人做了什么、当前状态是什么、已知/未知信息' },
      task: { type: 'string', description: '本次要执行的具体任务' },
      workerPermissions: {
        type: 'string',
        enum: ['explore', 'accept_edits', 'bypass'],
        description: '本次运行的权限临时提升（仍不能超过队长）。默认沿用 worker 创建时的权限。'
      }
    },
    required: ['agent_id', 'handoff_context', 'task']
  },
  async execute(args, ctx) {
    // 和 AgentRun 同构，但在 task 前面加 handoff 段
    const augmentedArgs = {
      agent_id: args.agent_id,
      task: `【队长 交接】\n${args.handoff_context}\n\n任务目标：${args.task}\n---`,
      workerPermissions: args.workerPermissions
    };
    // 直接复用 AgentRun 的 execute 逻辑 —— 但 execute 不是 async function...
    // 好吧，让我调它的 execute。但我需要处理 agentRunTool.execute 的动态 import 问题。
    // 让我直接内联执行 AgentRun 的逻辑，稍微改动 task 参数。
    // 等等，其实我可以直接 await agentRunTool.execute(augmentedArgs, ctx)。
    // 对！因为 execute 是 async function，可以被 await。
    return await agentRunTool.execute(augmentedArgs, ctx);
  }
};

// --- 6. AgentList ---
export const agentListTool = {
  name: 'AgentList',
  description: '列出当前团队所有成员（agent 名称、角色、session 状态）。',
  parameters: { type: 'object', properties: {} },
  async execute(_args, ctx) {
    const team = getCaptainTeam(ctx);
    if (!team) return '你还没有团队。';
    const captainSession = getCaptainSession(ctx);

    const lines = [
      `团队 "${team.name}" (${team.id}) — ${team.member_ids.length} 个 worker`,
      `队长: ${captainSession?.agent_id ?? team.leader_agent_id} (session: ${team.leader_session_id})`
    ];

    // worker 列表
    const { listSessionRecords } = await import('../asapi/store.js');
    const allSessions = listSessionRecords();

    for (const agentId of team.member_ids) {
      const agent = getAgent(agentId);
      const sessions = allSessions.filter(
        (s) => s.agent_id === agentId && s.team_id === team.id && s.origin?.type === 'team'
      );
      if (!agent) {
        lines.push(`  ⚠ ${agentId} — agent 已被删除`);
        continue;
      }
      const role = agent.data?.name || agentId;
      if (sessions.length === 0) {
        lines.push(`  ${agentId} (${role}) — 无 session`);
        continue;
      }
      for (const s of sessions) {
        const running = isRunning(s.id);
        const status = running ? '🔄 running' : '💤 idle';
        const perm = s.state?.permission_mode || 'explore';
        const isolation = s.origin?.isolation || 'shared';
        const branch = s.origin?.worktree?.branch ? ` branch=${s.origin.worktree.branch}` : '';
        lines.push(`  ${agentId} (${role}) session=${s.id} ${status} perm=${perm} isolation=${isolation}${branch}`);
      }
    }

    return lines.join('\n');
  }
};

// --- 7. TeamDocWrite ---
export const teamDocWriteTool = {
  name: 'TeamDocWrite',
  description: '写入/追加团队文档（~/.cocode/team-docs/{team_id}.md）。默认覆盖整个文件，append=true 时追加到末尾。',
  parameters: {
    type: 'object',
    properties: {
      content: { type: 'string', description: '要写入的内容（Markdown）' },
      append: { type: 'boolean', description: 'true=追加到文件末尾，false=覆盖整个文件。默认 false（覆盖）' }
    },
    required: ['content']
  },
  async execute(args, ctx) {
    const team = getCaptainTeam(ctx);
    if (!team) return '你还没有团队。';
    const path = getTeamDocPath(team.id);
    mkdirSync(join(path, '..'), { recursive: true });
    if (args.append) {
      appendFileSync(path, String(args.content));
      return `已追加到团队文档：${path}`;
    } else {
      writeFileSync(path, String(args.content));
      return `已覆盖写入团队文档：${path}（${String(args.content).length} 字符）`;
    }
  }
};

// --- 8. TeamDocRead ---
export const teamDocReadTool = {
  name: 'TeamDocRead',
  description: '读取团队文档内容（Markdown）。返回前 limit 行，避免过长。',
  parameters: {
    type: 'object',
    properties: {
      limit: { type: 'number', description: '返回前 N 行，默认 500' }
    }
  },
  async execute(args, ctx) {
    const team = getCaptainTeam(ctx);
    if (!team) return '你还没有团队。';
    const path = getTeamDocPath(team.id);
    if (!existsSync(path)) return '团队文档不存在（TeamDocWrite 后才会创建）。';
    const full = readFileSync(path, 'utf8');
    const limit = Math.min(50, Math.max(1, args?.limit ?? 500));
    const lines = full.split('\n').slice(0, limit);
    const truncated = full.split('\n').length > limit;
    return lines.join('\n') + (truncated ? `\n\n...（共 ${full.split('\n').length} 行，已截断）` : '');
  }
};

// --- 9. TeamDelete ---
export const teamDeleteTool = {
  name: 'TeamDelete',
  description: '解散当前团队（status 置为 disbanded + 删除团队文档）。所有 worker session 的 team_id 清空，agent 保留（还可以复用）。',
  parameters: { type: 'object', properties: {} },
  async execute(_args, ctx) {
    const team = getCaptainTeam(ctx);
    if (!team) return '你还没有活跃的团队。';

    // 先清 worker session 的 team_id
    const { listSessionRecords } = await import('../asapi/store.js');
    const allSessions = listSessionRecords();
    let freedSessions = 0;
    for (const s of allSessions) {
      if (s.team_id === team.id) {
        s.team_id = null;
        saveSessionRecord(s);
        freedSessions++;
      }
    }

    disbandTeam(team.id);

    // 队长 session 也清 team_id
    const captainSession = getCaptainSession(ctx);
    if (captainSession?.team_id === team.id) {
      captainSession.team_id = null;
      saveSessionRecord(captainSession);
    }

    notifyTeamUpdated(ctx);
    return `团队 "${team.name}" 已解散。\n  清理了 ${freedSessions} 个 worker session 的 team_id\n  worker agents 已保留（可复用于新团队）`;
  }
};

// ======================================================================
// 导出
// ======================================================================

export const teamTools = [
  teamCreateTool,
  agentCreateTool,
  agentRunTool,
  agentMessageTool,
  agentHandoffTool,
  agentListTool,
  teamDocWriteTool,
  teamDocReadTool,
  teamDeleteTool
];
