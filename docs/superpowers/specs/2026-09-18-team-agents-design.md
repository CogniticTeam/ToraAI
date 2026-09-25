# 多智能体团队协作（Team Agents）设计（v1）

- 日期：2026-09-18
- 状态：设计已确认，待实施
- 范围：补齐前端已预埋的 TeamPanel / team_updated 事件 / SessionRecord.team_id 等协议，新增工具族（TeamCreate/AgentCreate/AgentRun/AgentMessage/AgentHandoff/AgentList/TeamDocWrite/TeamDocRead/TeamDelete），实现队长-成员集中调度模型；**不**发明新的 Agent 调度器、不引入跨会话 bus、不污染 SSE 层
- 后续设计：本文是四大子系统的第 ① 个，后续按顺序设计 ③ 反思返工循环 → ④ 结构化输出 → ② 可视化工作流画布

---

## 1. 背景与目标

CoCode 前端已预埋 Team 协议（TeamPanel、SessionView.team、origin.type='team'、team_id 字段、team_updated SSE 事件），但后端完全是空壳 —— `/teams/*` 路由不存在、TeamRecord 无读写、工具族未实现。

本功能补齐这套协议，让一个 Agent（队长）能在一次 runAgent 循环内：
1. 用 TeamCreate 发起团队
2. 用 AgentCreate 建角色化成员（带 role/goal/backstory 的 Agent 人设）
3. 用 AgentRun 给成员派任务、触发它独立跑一次 runAgent
4. 用 AgentMessage / AgentHandoff 与成员通讯、交接
5. 用 TeamDoc 读写团队共享笔记

架构选型：**方案 A — 工具级 Team**（与 Subagent 同级的工具），吸收方案 C（编排层 Team）的 TeamDoc 特性；**不**做 Swarm 式自由交接（worker 之间消息必须经队长）。

## 2. 已确认决策

| 决策点 | 结论 | 来源 |
|---|---|---|
| Worker run 机制 | 复用 runAgent，不发明新调度器 | 设计定 |
| 消息传递 | 不做跨会话即时 bus；AgentMessage 入队，AgentRun 触发一次性跑 | 设计定 |
| Worker 权限 | 默认 explore（只读）；队长可显式给 accept_edits/bypass；worker 权限不能高于队长 | Subagent 对齐 |
| Worker run 过程不上队长界面 | 队长只收到最终摘要，用户想看过程需从 TeamPanel 跳 worker 会话 | 对齐 Subagent |
| 角色创建 | AgentCreate 主路径=当场建角色化 Agent（role/goal/backstory 进人设系统），辅路径=复用已有 agent_id | 用户同意 |
| Worker 递归 | spawnDepth>0 时过滤掉 TeamCreate/AgentCreate，防指数爆炸 | 对齐 Subagent |
| Worker 遇权限询问 | 不带 permissionAsk 通道，ask 自动退化为 deny；想让 worker 有写权限必须队长显式开 accept_edits/bypass | 对齐 Subagent |
| 存储 | 复用 store.js JSON 文件范式，零新依赖 | 对齐既有 |
| 前端改动 | 零改动！TeamPanel 等已就绪 | 前置条件 |

## 3. 文件清单

**新增**（2 个文件，约 750 行）：

| 文件 | 行数 | 内容 |
|---|---|---|
| `packages/core/src/tools/team.js` | ~600 | 9 个 teamTools + runWorker 内部函数 + 权限校验 + 内存消息队列 |
| `packages/core/src/asapi/team-store.js` | ~150 | TeamRecord CRUD + TeamDoc 路径函数 |

**修改**（6 个文件，每个 5-20 行小增量）：

| 文件 | 改动 |
|---|---|
| `packages/core/src/agent.js` | L30 加 `import { teamTools }`；L366-371 allTools 里条件注册 |
| `packages/core/src/asapi/server.js` | 加 `/teams/*` 读写路由 6 个 if 分支 + team-store import |
| `packages/core/src/asapi/protocol.js` | 加 `E.hint('team_message', {...})` 辅助 |
| `packages/core/src/asapi/bridge.js` | **不修改** |
| `packages/core/src/asapi/store.js` | **不修改**（SessionRecord.team_id 和 origin.type='team' 已存在） |
| `packages/core/src/hooks.js` / `automations.js` | **不修改**（可留钩子/自动化在后续迭代） |
| `zh.json` / `en.json` | 加 9 个工具的中文描述 + TeamPanel 空态文案微调 |

## 4. 数据模型与存储

### 4.1 目录结构

```
~/.cocode/
├── teams.json                     # 索引：{ teams: [TeamRecord, ...] }
├── team-docs/                     # 团队共享 markdown 笔记目录
│   └── {team_id}.md
└── asapi/
    ├── sessions/*.json            # 已有
    └── agents/*.json               # 已有
```

### 4.2 TeamRecord 结构

```json
{
  "id": "team_xxx",
  "created_at": "ISO",
  "updated_at": "ISO",
  "user_id": "local",

  "name": "电商前端重构",
  "description": "把 Vue2 项目迁到 React + TS",

  "leader_session_id": "session_abc",
  "leader_agent_id":   "agent_abc",

  "member_ids": ["agent_dev", "agent_designer"],

  "status": "active"
}
```

字段对齐前端 `TeamRecord` 类型，`leader_session_id` 和 `leader_agent_id` 冗余存储便于快速查询。

### 4.3 Worker 会话标记

完全复用现有 `SessionRecord`，不新增字段：
- `origin: { type: 'team' }`（前端已识别）
- `team_id: 'team_xxx'`（store.js 已有字段）

### 4.4 消息队列（瞬时状态）

放 `team.js` 模块顶层的 `Map<agent_id, [{from, content, at}]>`，进程重启丢了也没事 —— 队长下次 AgentRun 再发就行。

### 4.5 TeamDoc

纯 markdown 文本，直接写 `team-docs/{team_id}.md`。空文件当不存在处理。工具层做轻量 check-then-write，重试 1 次应对并发。

### 4.6 team-store.js 函数清单

```js
export function listTeams()                       // 读 teams.json，按 updated_at 排
export function getTeam(id)                       // 单个 TeamRecord，不存在返回 null
export function createTeam({leader_session_id, leader_agent_id, name, description})
export function updateTeam(id, {name?, description?})
export function addTeamMember(team_id, agent_id)
export function removeTeamMember(team_id, agent_id)
export function disbandTeam(team_id)              // status='disbanded'，保留历史
export function getTeamDocPath(team_id)           // 绝对路径
```

## 5. 工具族详细设计

### 5.1 TeamCreate

```js
{
  name: 'TeamCreate',
  description: '创建一个新团队。你作为队长，之后可以用 AgentCreate 建成员。',
  parameters: {
    name:        { type: 'string', description: '团队名称（2~40 字）' },
    description: { type: 'string', description: '团队目标/工作范围（可选）' }
  }
}
```

execute 校验 `spawnDepth > 0`（worker 里不能建团队），然后调用 team-store.createTeam。成功后返回："团队已创建，用 AgentCreate 建成员。"

每个 session 只能有一个团队 —— TeamCreate 第二次调用时返回"你已经有一个团队了，先解散再创建"。

### 5.2 AgentCreate

```js
{
  name: 'AgentCreate',
  description: '创建一个角色化团队成员（自动起一个独立会话）。' +
               'agent_id 可选：传了就复用已有 agent 人设，' +
               '不传则当场创建一个带 role/goal/backstory 的新 agent。' +
               'permissions 可选：默认 explore（只读），accept_edits 允许写文件，bypass 全开 —— 但不能超过你的权限。',
  parameters: {
    role:        { type: 'string', description: '角色名（如「前端工程师」「后端架构师」）' },
    goal:        { type: 'string', description: '这个成员要达成的具体目标（一句话）' },
    backstory:   { type: 'string', description: '背景设定：专长、偏好、性格（可选）' },
    permissions: { type: 'string', enum: ['explore', 'accept_edits', 'bypass'], description: '成员权限，默认 explore' },
    agent_id:    { type: 'string', description: '可选：复用已有 agent 人设的 id' }
  },
  required: ['role', 'goal']
}
```

execute 流程：
1. 校验 spawnDepth > 0 则拒绝
2. 权限矩阵校验（见第 7 节）
3. 有 agent_id → loadAgent(id)；无 → createAgent({ name: role, data: { role, goal, backstory }, ... })
4. store.createSessionRecord({ agent_id, origin: {type:'team'}, team_id, config: { ...继承队长配置 } })
5. team-store.addTeamMember(team_id, agent_id)
6. 返回 agent_id + session_id

### 5.3 AgentRun

```js
{
  name: 'AgentRun',
  description: '给成员一个任务并立即触发它独立跑一次。' +
               '会先把 AgentMessage 队列里 pending 的消息一起喂给它。' +
               '成员的模型配置从你继承，会话独立存在，跑不完不会阻塞你的下一轮工具调用（但本工具会等它完成才返回结果摘要）。',
  parameters: {
    agent_id: { type: 'string', description: '目标成员的 agent_id' },
    task:     { type: 'string', description: '要完成的任务（具体、可验证）' }
  },
  required: ['agent_id', 'task']
}
```

这是整个系统最复杂的工具，execute 流程：
1. loadSessionRecord 拿到 worker session
2. 合并消息：pendingQueue[agent_id]（team_message hint）+ 本次 task（user msg）
3. saveSessionRecord 持久化
4. resolveWorkerMode（第 7 节）
5. 调 runAgent 直调（不带 permissionAsk、不带 askUser、spawnDepth=1）
6. 遍历事件流累加到本地：text-delta 累成最终文本，统计 tool-start/tool-result，跳过 require-confirm/ask-user（因为无通道自动 deny）
7. run 结束后 saveSessionRecord 更新 internal/display
8. 把 tool 结果转译成 agentscope Msg[]（display）让前端打开 worker 会话能看到完整对话
9. 返回队长摘要：完成/失败原因、工具调用统计、产出摘要

### 5.4 AgentMessage

```js
{
  name: 'AgentMessage',
  description: '向指定成员发一条消息（入队）。' +
               '消息不会自动触发它跑 —— 要它动起来用 AgentRun。' +
               '适合传递上下文细节、补充信息。',
  parameters: {
    agent_id: { type: 'string' },
    content:  { type: 'string', description: '自然语言内容' }
  }
}
```

execute 做两件事：push 进 pendingQueue + 追加一条 team_message hint 到 worker session.display[]（让前端能看到"有消息待处理"）。

### 5.5 AgentHandoff

```js
{
  name: 'AgentHandoff',
  description: '把工作交接给某位成员继续。比 AgentRun 多一段「队长交接语」' +
               '（已完成的工作、关键上下文、注意事项），让它能无缝接棒。',
  parameters: {
    agent_id:        { type: 'string' },
    task:            { type: 'string', description: '续做的任务目标' },
    handoff_context: { type: 'string', description: '已完成工作 + 关键上下文 + 注意事项' }
  }
}
```

内部和 AgentRun 同构，但在喂给 worker 的消息最前面加：

```
【队长 交接】
以下是我已完成的工作和上下文，请接着做：
{handoff_context}

任务目标：{task}
---
```

**不**做自动 handoff 链 —— 必须回队长决策再 handoff。

### 5.6 AgentList

```js
{
  name: 'AgentList',
  description: '列出本团队全部成员、各自 session 状态、最近一次 run 的摘要。'
}
```

返回格式：
```
团队「电商前端重构」（3 成员）：
  - 前端 (agent_dev / sess_001)      [idle]   最后：登录表单 (Edit×7, Bash×3)
  - 后端 (agent_backend / sess_003)  [idle]   还没派过任务
  - 设计师 (agent_design / sess_002) [running] 正在跑……
```

状态来源：TeamRecord.member_ids → 逐个 loadSessionRecord → bridge.isRunning() → session.state.last_run_summary。

### 5.7 TeamDocWrite / TeamDocRead

```js
// TeamDocWrite
{ name: 'TeamDocWrite',
  parameters: { content: { type:'string' }, append: { type:'boolean', default:false } } }

// TeamDocRead
{ name: 'TeamDocRead',
  parameters: { limit: { type:'number', default:500 } } }
```

极简 markdown 笔记。TeamDocWrite 默认覆盖；append=true 尾部追加。TeamDocRead 默认读前 500 行（省 token）。不做版本控制、不做并发锁（check-then-write + 重试 1 次）。

### 5.8 TeamDelete

解散团队：TeamRecord.status='disbanded'，所有 worker 会话 team_id 置 null（解除关联但保留会话历史），删除 team-docs/{id}.md。

## 6. runWorker 内部函数（team.js 内部，不暴露给模型）

```js
async function runWorker({
  cfg, messages, permissionMode, sessionState, checkpoint, cwd
}) {
  // 不传 permissionRules：agent.js 默认值为 []，worker 不继承队长的自定义权限规则，
  // 避免"git push 永远允许"这类队长规则错误作用到 worker 上。
  let finalText = '';
  let toolCalls = 0;
  let denied = 0;
  const startTs = Date.now();
  const ac = new AbortController();

  for await (const e of runAgent({
    cfg, messages,
    permissionMode,
    spawnDepth: 1,                   // 禁递归 TeamCreate/AgentCreate
    sessionState,
    checkpoint,
    cwd,
    signal: ac.signal
  })) {
    if (e.type === 'text-delta') finalText += e.text ?? '';
    else if (e.type === 'tool-start') toolCalls++;
    else if (e.type === 'tool-result' && e.ok === false) denied++;
    else if (e.type === 'done') {
      return {
        success: e.reason === 'completed',
        reason: e.reason,
        text: finalText.trim(),
        toolCalls, denied,
        durationMs: Date.now() - startTs
      };
    }
  }
  // runAgent 提前退出（理论上不会）
  return { success: false, reason: 'agent-exit', text: finalText, toolCalls, denied };
}
```

不处理 require-confirm / ask-user —— runAgent 内部会自动退化为 deny / 返回"无交互通道"兜底，不会卡死。

## 7. 权限矩阵与 WorkerMode 解析

### 7.1 resolveWorkerMode(captainMode, agentCreatePermissions)

| 队长 mode | 未传 permissions | 'accept_edits' | 'bypass' |
|---|---|---|---|
| bypass | bypass（跟随） | accept_edits | bypass |
| accept_edits | accept_edits（跟随） | accept_edits | **error**（队长没开更高权限）|
| default | **explore**（只读）| accept_edits | **error** |
| explore | explore（跟随）| **error** | **error** |

### 7.2 AgentCreate 内校验

AgentCreate 收到 permissions 参数时，先算上限（队长权限能给到的最高）：
- bypass 队长能给 bypass/accept_edits/explore
- accept_edits 队长能给 accept_edits/explore
- default 队长能给 accept_edits/explore
- explore 队长只能给 explore

越权直接返回工具错误："你是 default 模式，不能给成员开 bypass 权限。切到 bypass 或去掉 permissions 参数（默认 explore）。"

### 7.3 Worker 自带权限规则

Worker 的 runAgent 调用时，传入 `permissionRules` 为空数组（不继承队长的自定义规则）。理由：
- 规则是用户针对队长自己会话写的（"git push 永远允许"），worker 不一定适用
- 如果真要给 worker 加规则，在 AgentCreate.permissions 里开模式就够了

## 8. session 持久化与 display 生成

runWorker 结束后，必须把 worker 的完整对话落盘并生成 display（agentscope Msg[]），让前端 TeamPanel 点进 worker 会话时能看到完整历史。

display 生成逻辑对齐 protocol.js 的 E() 范式：
- assistant 回复 → E.assistant
- tool_call / tool_result → E.tool_use / E.tool_result
- require-confirm → E.confirm（但 worker run 不会产生）
- team_message → E.hint('team_message', ...)

session.state.last_run_summary 存最后一次 run 摘要（AgentList 显示用），格式：
```js
{
  at: 'ISO',
  durationMs: 32000,
  toolCalls: 12,
  denied: 0,
  task: '实现登录表单',     // AgentRun 的 task 参数
  success: true
}
```

## 9. /teams/* 路由设计（server.js 内 if 分支）

所有写操作校验 `team.leader_session_id === query.session_id`，否则 403。

```
GET    /teams/                → listTeams()
GET    /teams/:id             → getTeam(id)  + 头部 5 行 doc 预览
GET    /teams/:id/doc         → 读完整 TeamDoc
POST   /teams/                → createTeam({name, description, leader_session_id})
PATCH  /teams/:id             → updateTeam(id, body)
DELETE /teams/:id             → disbandTeam(id)
```

请求解析完全沿用现有 `readBody(req)` + `json(res, 200, body)` + `apiError(res, code, msg)` 范式。

## 10. 工具注册与 system prompt

### 10.1 agent.js 注册

```js
import { teamTools } from './tools/team.js';

// _runAgentImpl 内 allTools 构建：
const allTools = [
  ...builtinTools,
  ...extraTools,
  ...mcpTools,
  ...(spawnDepth > 0 ? [] : subagentTools),
  ...(spawnDepth > 0 ? [] : teamTools),    // ← 这里
];
```

spawnDepth > 0 时（本身就是 worker run）过滤掉 teamTools —— 防递归、防 worker 自己拉团队。

### 10.2 工具分类（toolCategory）

在 builtin.js 的 toolCategory switch 里加：
```js
case 'TeamCreate': case 'AgentCreate': case 'AgentDelete':
  return 'execute';
case 'AgentRun': case 'AgentHandoff':
  return 'execute';     // 派发任务 = 执行操作
case 'AgentMessage': case 'AgentList':
  return 'read';        // 发消息/查状态 = 读
case 'TeamDocWrite':
  return 'write';
case 'TeamDocRead':
  return 'read';
case 'TeamDelete':
  return 'execute';
```

这决定了权限决策的默认放行策略（default 模式下 read 自动放行，write/execute 要问）。

### 10.3 系统提示引导

buildSystemPrompt（prompt.js）的工具说明里，自动根据注册工具生成列表，不需要硬编码团队工具的使用指引。但可以在 SYSTEM_PROMPT 里加一行引导："你可以用 TeamCreate 建团队，让多个角色化 Agent 并行协作完成复杂任务。"

## 11. 事件流（runWorker 不发出 event，但内部消费）

runAgent 事件流里，worker run 会正常产生所有事件（text-delta、tool-start、tool-result 等），但 runWorker **不把这些 emit 到队长的事件流** —— 它只在本地消费，最后返回摘要。这和 Subagent 的行为完全一致。

如果以后需要让队长实时看到 worker 进度（类似 Swarm 的"群聊可视化"），那是 v2 的事，v1 不做。

## 12. 测试

### 12.1 新增测试文件

`packages/core/test/team.js` — 参考 `test/memory.js` / `test/asapi.js` 风格。

覆盖场景：
1. TeamCreate / AgentCreate / AgentRun 完整 happy path（bypass 模式，worker 跑成功）
2. 权限矩阵：explore 队长不能开 write worker；bypass 队长开 accept_edits worker
3. Worker run 带 Read/Grep 工具调用，结果落盘
4. Worker run 遇 Write 自动 denied（default 队长 + explore worker）
5. spawnDepth 递归：worker 里调 AgentCreate 被拒绝
6. AgentHandoff + 后续 AgentRun：handoff 内容正确注入
7. AgentMessage 入队 + AgentRun 时一起喂
8. TeamDocWrite/Read 覆盖 + append
9. TeamDelete 解散后 worker team_id 置 null

### 12.2 集成回归

既有测试集（test/asapi.js、test/memory.js、test/run.js）应该全部通过 —— 本次新增文件无破坏性修改。

## 13. 未覆盖功能（明确留给后续迭代）

- Swarm 式自由交接 / 扁平群聊（worker 之间直接消息，无需队长中转）
- Worker 实时流式输出到队长界面
- AgentSchedule：定时自动触发某个 worker 跑
- AgentHITL：worker 遇到权限询问时回流到队长界面
- 团队级权限规则持久化（permissionRules 给 worker 也配规则）
- 前端 TeamPanel 里"查看 worker 运行中状态"的实时刷新（目前只有 idle/running 粗粒度）
- 前端 TeamDoc 编辑 UI（目前只有工具读写，前端不暴露）
