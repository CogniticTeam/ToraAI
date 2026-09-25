# 可视化工作流画布（Workflow Canvas）设计（v1）

- 日期：2026-09-18
- 状态：设计已确认，待实施
- 范围：前端工作流画布（节点 + 边 + 配置面板），后端 workflow 存储 + 运行时执行引擎；与现有 runAgent 结合，不发明新调度器；复用 MCP 工坊的节点 UI 模式
- 规模：最大的一个子系统，**预估 3500-4500 行**（前端画布 ~2000 + 后端引擎 ~1500 + 存储/API ~300）
- 优先级：三个小的（team / review / structured）先做；本设计单独在它们之后实现

---

## 1. 背景与目标

CrewAI Flows、LangGraph、Dify 的核心价值是"把多步骤复杂任务变成一张图" —— 用户不需要写 prompt chain，只要在画布上拖节点、连线、填配置，就能编排一个可保存、可重放、可共享的 Agent 流程。

CoCode 已有：
- Event-triggered automations（单层"当 X 发生时做 Y"规则）
- MCP Workshop（单节点工具试调）
- Team Agent（多 Agent 集中调度）

但缺一张**真正的画布**让用户把这些东西串起来。

## 2. 已确认决策

| 决策点 | 结论 | 来源 |
|---|---|---|
| 核心抽象 | 节点 + 边 + 全局输入/输出变量 + 条件分支 + 循环 | 设计定 |
| 节点类型 | llm / tool / subagent / condition / loop / human-input / start / end | 设计定 |
| 执行引擎 | 后端 JS 引擎，按拓扑排序 + 条件分支路由，**不是** runAgent 循环内的 | 设计定 |
| 状态 | 每次运行写 run.json（输入快照 + 节点日志 + 输出），可重放 | 设计定 |
| 存储 | workflows/*.json（定义）+ workflow-runs/{id}.json（运行记录），零依赖 | 对齐既有 |
| 前端画布 | React Flow（成熟、社区活跃、MIT 协议，**不引入重型编辑器**） | 方案选定 |
| 运行触发 | POST /workflows/:id/run + 前端 "运行" 按钮；**不**挂到 Automations 上（v1 不做触发集成） | 设计定 |
| 最大规模 | 单个 workflow ≤ 30 节点、depth ≤ 10（防爆） | 设计定 |
| v1 范围 | 画布拖拽 + 节点配置 + 运行 + 日志；**不**做共享/导入导出 UI、不做版本控制、不做条件分支可视化编辑（条件用 JSON 表达式） | 设计定 |

## 3. 节点类型与能力

### 3.1 Start / End（起点 / 终点）

- Start：唯一，接收运行时输入 `{variables: {...}}`，注入全局变量池
- End：至少一个，收集 `result` 作为 workflow 最终输出

### 3.2 LLM 节点（核心）

```js
{
  id: 'n1',
  type: 'llm',
  config: {
    model_ref: 'model_name',
    prompt: '根据 {{variables.topic}} 写一段 {{variables.length}} 字的介绍',
    // 模板语法：{{var}} 从全局变量池或上游节点 output 取值
    system_prompt: '',
    temperature: 0.7,
    output_schema: null    // 可选结构化输出（复用设计 ④ 的能力）
  },
  inputs: ['n0'],     // 上游节点 id
  outputs: ['n2', 'n3']  // 下游节点 id（可多分支）
}
```

### 3.3 Tool 节点

```js
{
  type: 'tool',
  config: {
    tool_name: 'Bash',                       // 内置工具名
    args_template: { command: 'npm test' }    // 模板也可嵌 {{variables.x}}
  },
  inputs: ['n1'],
  outputs: ['n4']
}
```

Tool 节点直接调 agent.js 的 builtinTools（不经过 runAgent），是 workflow 引擎和工具层的直接桥。

### 3.4 Subagent 节点（自动接 Team Agent）

```js
{
  type: 'subagent',
  config: {
    role: '前端工程师',
    goal: '实现 {{variables.task}}',
    permissions: 'accept_edits'
  },
  inputs: ['n1'],
  outputs: ['n5']
}
```

内部调 `runWorker({...})`（team.js 的内部函数），和 Team Agent 共用。

### 3.5 Condition 节点（条件分支）

```js
{
  type: 'condition',
  config: {
    branches: [
      { match: '{{output.pass}} === true', output: 'n6' },    // true 分支
      { match: 'true', output: 'n7' }                          // else 分支
    ]
  },
  inputs: ['n5'],
  outputs: ['n6', 'n7']   // 两路
}
```

match 表达式是**极简 JS 表达式**，用 `new Function()` 执行，变量池注入。**不**支持任意 JS（白名单限制）。

### 3.6 Loop 节点（循环）

```js
{
  type: 'loop',
  config: {
    over: '{{variables.items}}',     // 可迭代数组
    item_var: 'item',
    max_iterations: 50,              // 硬上限
    loop_body: 'n8',                 // 循环体入口节点
    then: 'n9'                       // 循环结束后
  },
  inputs: ['n0'],
  outputs: ['n8', 'n9']
}
```

Loop 是 workflow 引擎内部实现，不是实际节点类型（条件分支路由）。

### 3.7 Human Input 节点（人工审批）

```js
{
  type: 'human',
  config: {
    message: '请确认是否部署到生产环境',
    options: ['yes', 'no', 'cancel']
  },
  inputs: ['n5'],
  outputs: ['n6', 'n7']   // yes/no 两路
}
```

实现：引擎停在此节点 → 前端 poll 状态 → 用户选 → 引擎继续。

## 4. 执行引擎（后端 JS）

### 4.1 核心算法

```js
async function runWorkflow(workflowId, inputs, opts) {
  const wf = loadWorkflow(workflowId);
  const runId = 'run_' + uid();
  const log = [];                          // 节点执行日志
  const state = { variables: { ...inputs.variables } };  // 全局变量池

  // 1) 拓扑排序
  const nodes = topoSort(wf.nodes);        // 无环有向图拓扑
  const start = nodes.find(n => n.type === 'start');
  
  // 2) 从 start 开始 BFS / DFS 执行（按边的 outputs 路由）
  const queue = [start];
  const visited = new Set();
  
  while (queue.length) {
    const node = queue.shift();
    if (visited.has(node.id)) continue;
    visited.add(node.id);

    log.push({ node: node.id, at: now(), input: resolveTemplates(node.inputs, state) });

    let result;
    try {
      result = await executeNode(node, state, opts);
    } catch (e) {
      log.push({ node: node.id, error: e.message });
      // 错误策略：默认 halt（整个 workflow 停）；可配 continue
      break;
    }

    state[node.id] = result;  // 每个节点的 output 以 node.id 为 key 存进 state
    log.push({ node: node.id, done: true, output: truncate(result) });

    // 条件分支节点按 match 决定哪一路继续
    if (node.type === 'condition') {
      const next = pickBranch(node.config.branches, state);
      if (next) queue.push(next);
    } else {
      for (const outId of node.outputs) queue.push(outId);
    }
  }

  // 3) 收尾：找 end 节点 output
  const end = nodes.find(n => n.type === 'end');
  const final = end ? state[end.id] : state;
  
  saveWorkflowRun(runId, { workflowId, inputs, log, final, status: 'done', duration: now() });
  return { runId, final, log };
}
```

### 4.2 executeNode 分发表

```js
async function executeNode(node, state, opts) {
  switch (node.type) {
    case 'start':    return state.variables;
    case 'end':      return state;
    case 'llm':      return await executeLlm(node, state, opts);
    case 'tool':     return await executeTool(node, state, opts);
    case 'subagent': return await executeSubagent(node, state, opts);
    case 'condition':return evaluateCondition(node, state);    // 不阻塞，直接返回 next id
    case 'human':    return await executeHuman(node, state, opts);
    case 'loop':     return await executeLoop(node, state, opts);
    default: throw new Error(`未知节点类型 ${node.type}`);
  }
}
```

### 4.3 模板解析

```js
function resolveTemplate(str, state) {
  // 支持 {{variables.x.y.z}} 和 {{nodeId.field}}
  return String(str).replace(/\{\{(.+?)\}\}/g, (_, expr) => {
    const exprTrimmed = expr.trim();
    const parts = exprTrimmed.split('.');
    if (parts[0] === 'variables') return deepGet(state.variables, parts.slice(1));
    // 否则按 nodeId 查 state[nodeId]
    const nodeId = parts[0];
    return deepGet(state[nodeId], parts.slice(1));
  });
}
```

### 4.4 权限

Tool 节点执行时复用 `resolveTool` → 直接调 tool.execute。**不带**权限询问通道（和 Worker 一样），默认 bypass（用户显式 `opts.permission='explore'` 时拒绝写操作）。Human Input 节点除外（走用户）。

## 5. 存储

```
~/.cocode/
├── workflows/
│   └── {id}.json          # 工作流定义
└── workflow-runs/
    └── {runId}.json       # 运行记录
```

workflow.json 结构：
```json
{
  "id": "wf_xxx",
  "created_at": "ISO",
  "updated_at": "ISO",
  "name": "代码检查流水线",
  "description": "自动做 lint + test + 报告",
  "version": 1,
  "nodes": [
    { "id": "n0", "type": "start", "config": {}, "inputs": [], "outputs": ["n1"] },
    { "id": "n1", "type": "tool",
      "config": { "tool_name": "Bash", "args_template": { "command": "npm run lint" } },
      "inputs": ["n0"], "outputs": ["n2"] },
    { "id": "n2", "type": "condition",
      "config": { "branches": [
        { "match": "{{n1.exit_code}} === 0", "output": "n3" },
        { "match": "true", "output": "n4" }
      ]},
      "inputs": ["n1"], "outputs": ["n3", "n4"] },
    { "id": "n3", "type": "tool",
      "config": { "tool_name": "Bash", "args_template": { "command": "npm test" } },
      "inputs": ["n2"], "outputs": ["n5"] },
    { "id": "n4", "type": "tool",
      "config": { "tool_name": "Bash", "args_template": { "command": "echo LINT FAILED" } },
      "inputs": ["n2"], "outputs": ["n5"] },
    { "id": "n5", "type": "llm",
      "config": {
        "model_ref": "deepseek-flash",
        "prompt": "总结以下流水线结果：lint={{n1.exit_code}}，test={{n3.exit_code}}"
      },
      "inputs": ["n3", "n4"], "outputs": ["n6"] },
    { "id": "n6", "type": "end", "config": {}, "inputs": ["n5"], "outputs": [] }
  ]
}
```

## 6. API 路由

```
GET    /workflows/               → list()
POST   /workflows/               → create()
GET    /workflows/:id            → get()
PATCH  /workflows/:id            → update()
DELETE /workflows/:id            → delete()

POST   /workflows/:id/run        → run(inputs)  {input_variables}
GET    /workflows/:id/runs       → list runs（可分页）
GET    /workflows/runs/:runId    → 单个 run 详情（日志 + 最终输出）
POST   /workflows/runs/:runId/human → 处理 human-input 节点的回答
POST   /workflows/runs/:runId/cancel → 取消正在跑的
```

## 7. 前端画布

**技术选型**：React Flow（`@xyflow/react`，MIT，npm ~2MB gzip ~500KB）

核心组件：
- `WorkflowCanvas.tsx` — 画布 + 拖拽 + 边连线
- `node-registry/*.tsx` — 每种节点类型的配置面板（NodeToolbar + NodeConfig）
- `WorkflowPanel.tsx` — 右侧抽屉，列出所有 workflow 让用户打开
- `WorkflowRunLog.tsx` — 运行日志面板，实时刷新节点状态

**不做**：
- 条件分支可视化（用 JSON 表达式文本框；v2 再做 if/else 图形化）
- 循环可视化（同上）
- 运行时高亮（静态图）
- 版本历史

## 8. 文件清单

**新增**（~10 个文件，约 3500-4500 行）：

| 文件 | 内容 |
|---|---|
| `packages/core/src/tools/workflow.js` | workflow 引擎（runWorkflow / executeNode / topoSort / template）~800 行 |
| `packages/core/src/asapi/workflow-store.js` | 存储 CRUD ~120 行 |
| `packages/desktop/frontend/src/components/workflow/WorkflowCanvas.tsx` | 主画布 ~800 行 |
| `packages/desktop/frontend/src/components/workflow/nodes/*.tsx` | 7 种节点配置面板 ~800 行 |
| `packages/desktop/frontend/src/components/workflow/WorkflowPanel.tsx` | 工作流列表抽屉 ~300 行 |
| `packages/desktop/frontend/src/components/workflow/WorkflowRunLog.tsx` | 运行日志面板 ~300 行 |
| `packages/desktop/frontend/src/hooks/useWorkflows.ts` | 状态管理 hook ~150 行 |

**修改**：
- `agent.js`：不修改
- `server.js`：加 `/workflows/*` 路由 ~8 个 if 分支
- `ChatViewport.tsx`：panel dock 加 workflow 入口

## 9. 测试

新增 `packages/core/test/workflow.js`：
1. 简单 linear workflow（start → llm → end）
2. 条件分支（condition → toolA / toolB）
3. 循环（loop 10 次 tool）
4. 错误 halt：tool 抛错 → 后续节点不执行
5. 模板解析：`{{variables.x.y.z}}` + `{{nodeId.field}}`
6. 拓扑排序检测：有环 → 拒绝保存
7. max_iterations 防爆

## 10. 与其他三个设计的交互

- **Team Agent**：workflow 的 `subagent` 节点直接调 team.js 的 runWorker（零额外代码）
- **Review Loop**：LLM 节点执行时，可在 node.config 里开 `review: { enabled: true, max_rounds: 2 }`
- **Structured Output**：LLM 节点 `config.output_schema` 直接复用设计 ④ 的能力

三者都是 **workflow 的节点能力**，而不是 workflow 的子系统 —— 这就是为什么它们先实现。

## 11. 明确不做（v2 考虑）

- 工作流自动触发（挂到 Automations / Schedule）
- 工作流共享 / 导入导出（JSON 可以手动）
- 版本控制
- 工作流之间嵌套（嵌套 Subagent 足矣）
- 运行时可视化调试（节点执行高亮、断点）
- 工作流 Marketplace（云端下载别人的 workflow）
