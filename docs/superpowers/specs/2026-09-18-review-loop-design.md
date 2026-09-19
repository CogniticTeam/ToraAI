# 反思返工循环（Critic-Review-Redo）设计（v1）

- 日期：2026-09-18
- 状态：设计已确认，待实施
- 范围：在 agent.js 的 finish 点前插入隐式 Critic 阶段，用同模型自我审查，不达标自动返工 N 轮；默认关，用户可在全局 config 或 Agent 级开启；**不**发明新调度器、**不**暴露新工具

---

## 1. 背景与目标

CoCode 的 runAgent 跑完一轮工具调用循环后，直接 `finish('completed')` 返回。这意味着如果模型在第一轮里"自以为正确地做完了"（工具都调完了、产出了文本），哪怕它的产出有逻辑漏洞、漏了步骤、工具用得不对，也不会再回头看一眼。

ChatDev 的 review 循环、AutoGPT 的自我审查、Reflexion 的 memory-reflect-revise 都在解决这个问题：**让模型对自己的产出再调用一次，用一段更严格的 prompt 审查，不达标就把反馈送回去让主 Agent 重做**。

## 2. 已确认决策

| 决策点 | 结论 | 来源 |
|---|---|---|
| 实现位置 | agent.js 的 `_runAgentImpl`，在 finish() 前插入 review 阶段 | 方案 A |
| Review 默认值 | 全局 `enabled: false`（成本双倍） | 设计定 |
| 返工内容 | 只重跑"生成最终答复"阶段（messages 末尾追加 Critic 反馈，让 agent 再跑一轮 finish），不重跑已成功的工具调用 | 设计定 |
| 模型复用 | 用同 client、同凭证、同模型做 self-review（v1 不支持独立 critic model）| 方案 A |
| 触发条件 | **主 Agent 正常完成**（reason='completed'）时才触发；aborted / blocked / error / max-turns 不触发 | 设计定 |
| Worker 继承 | Worker run（Team Agent）自动继承自己 Agent 人设里的 review 配置（优先级：Agent > 全局） | 设计定 |
| 暴露给模型 | 隐式步骤，**不**做 CriticReview 工具（避免依赖模型"记得"调用） | 方案 B 拒绝 |
| Trace 事件 | 新增 `review-start / review-result / review-redo` 三事件 | 设计定 |

## 3. 配置

### 3.1 全局 config（`~/.vega/config.json`）

```json
{
  "review": {
    "enabled": false,
    "max_rounds": 2,
    "min_turns": 3,
    "checklist": [
      "所有工具调用都成功（ok=true）还是有被拒绝/失败的？",
      "工具调用序列与任务目标匹配吗？有没有多余或遗漏的步骤？",
      "最终答复与任务目标直接对应吗？",
      "如果做了代码修改，有没有考虑构建/类型检查/测试？"
    ]
  }
}
```

- `enabled: false` —— 默认关（双倍 token 成本）
- `max_rounds: 2` —— 最多返工 2 轮后正常 finish
- `min_turns: 3` —— 少于 3 轮工具调用时跳过 review（明显还没做完，不值得审查）
- `checklist` —— 用户可自定义审查维度

### 3.2 Agent 级覆盖（`Agent.data.review`）

```js
{ enabled: true, max_rounds: 3 }
```

优先级：Agent 级 > 全局。Captain 开了 review 但 Worker 人设没开 → Worker 不 review。

## 4. 文件清单

**修改**（2 个文件，约 350 行小增量）：

| 文件 | 改动 |
|---|---|
| `packages/core/src/agent.js` | `_runAgentImpl` 尾部加 review loop（~200 行）+ 三个 trace emit |
| `packages/core/src/config.js` | `loadConfig` 默认值里加 `review` 字段（~20 行） |

**可选**（后续设置 UI 里加开关，v1 不做）：
- `SettingDialog.tsx` 加 review 配置区

## 5. review loop 核心流程

### 5.1 插入位置

在 `_runAgentImpl` 的 `for (let turn = 1; turn <= maxTurns; turn++)` 循环里：
```js
// 当前：正常循环跑完后
await finish('max-turns');
// return ← 直接返回

// 改造后：正常完成时（循环里 break 出来），不立刻 return，
// 把 messages 和 config 交给 review 阶段
if (shouldRunReview({ cfg, messages, turn, maxTurns, ... })) {
  await runReviewLoop({ client, cfg, messages, emit, finish, trace, minTurns, maxRounds });
} else {
  await finish('completed');
}
```

### 5.2 shouldRunReview 判断

```js
function shouldRunReview({ cfg, turn, maxTurns, exitReason, message, tools }) {
  // 配置没开 → 跳过
  const review = cfg.review || {};
  if (!review.enabled) return false;
  // 不是正常完成（aborted/blocked/error/max-turns）→ 跳过
  if (exitReason !== 'completed') return false;
  // 工具调用次数太少 → 跳过（明显还没做完）
  const toolCallCount = tools.filter(t => t !== undefined).length;
  const minTurns = review.min_turns ?? 3;
  if (toolCallCount < minTurns) return false;
  return true;
}
```

### 5.3 runReviewLoop 伪代码

```js
async function runReviewLoop({ client, cfg, messages, emit, finish, trace }) {
  const review = cfg.review || {};
  const maxRounds = review.max_rounds ?? 2;
  const checklist = buildChecklist(review, cfg);

  let redo = true;
  let round = 0;

  while (redo && round < maxRounds) {
    round++;
    emit({ type: 'review-start', round });

    // ---- Critic 阶段：给 CriticPrompt 让模型自审 ----
    const { message: critique, usage } = await chatCompletion(client, {
      messages: buildCriticMessages(messages, checklist),
      // 不开 tools：Critic 不调工具，只读已有轨迹做判断
      tools: undefined
    });
    trace.request(`review-${round}`, { promptType: 'critic', toolCalls: 0 });
    trace.response(`review-${round}`, { content: critique.content, usage });

    const parsed = parseCriticResult(critique.content);
    emit({
      type: 'review-result', round,
      passed: parsed.passed,
      issues: parsed.issues,
      reason: parsed.reason
    });

    if (parsed.passed) {
      // 通过 → 正常 finish
      return await finish('completed');
    }

    // ---- 不通过 → 把 Critic 反馈喂回去，让主 Agent 继续生成 ----
    emit({ type: 'review-redo', round, issues: parsed.issues });
    messages.push({
      role: 'user',
      content: CRITIC_FEEDBACK_PREFIX + critique.content
    });

    // 重跑主循环，**从新的 messages 继续迭代**
    // 注意：不重新做 compact 或 evict，只追加 + 再跑 turn 循环
    // 但 maxTurns 要变成原 maxTurns + 5（给 redo 留空间）
    const redoMaxTurns = cfg.maxTurns ?? 40 + 5;
    let exited = false;
    for (let rturn = 1; rturn <= redoMaxTurns; rturn++) {
      // ... 现有 chatCompletion + tool_calls + gate + invoke 逻辑不变 ...
      // 正常 break 出来 → 再 review
      if (正常完成) { exited = true; break; }
    }
    if (!exited) {
      // 又 max-turns 了 → 直接 finish，不再 review
      return await finish('max-turns');
    }
    // 回 while 再 review 一次
  }

  // 返工到 max_rounds 还没通过 → 直接 finish（最后一次 Critic 反馈附进 messages）
  emit({ type: 'review-result', round, passed: false, reason: 'max-rounds' });
  await finish('completed');
}
```

### 5.4 Critic Prompt 模板

```
你是一个代码审查专家。下面是另一个 AI agent 刚刚完成的任务执行轨迹：
- 它接到了什么任务
- 它调了哪些工具、每一步的结果
- 它最终给出了什么答复

请按以下清单逐项检查，返回一段 JSON：
{
  "passed": true/false,
  "issues": ["问题1", "问题2"],           // 仅当 passed=false 时填
  "reason": "一句话总体判断"
}

审查维度：
- {checklist[0]}
- {checklist[1]}
- ...

轨迹如下：
---
{serializeAgentMessages(messages)}
---

只返回 JSON，不要额外解释。
```

### 5.5 serializeAgentMessages（给 Critic 的轨迹序列化）

把 messages 数组里对 Critic 有用的内容挑出来：
- 跳过系统提示词（Critic 不需要知道 system）
- 跳过过长的 tool_result（截断到 400 字）
- 跳过中间 assistant 的 thinking-delta / 草稿，只保留 tool_calls + 最终答复
- 按 `[轮次] role | 工具/内容` 格式输出

## 6. Critic 结果解析（parseCriticResult）

```js
function parseCriticResult(text) {
  // 和 parseReactAction 同范式：先找 fenced code block，再找平衡括号
  const jsonText = extractFirstJson(text);
  if (!jsonText) return { passed: false, issues: [text.slice(0, 500)], reason: 'Critic 输出不是 JSON' };
  try {
    const obj = JSON.parse(jsonText);
    return {
      passed: Boolean(obj.passed),
      issues: Array.isArray(obj.issues) ? obj.issues.slice(0, 5) : [],
      reason: String(obj.reason ?? '')
    };
  } catch {
    return { passed: false, issues: ['Critic JSON 解析失败'], reason: '解析失败' };
  }
}
```

## 7. Trace 与事件流

新增三个 trace event + 对应 emit：
```
review-start     { round }
review-result    { round, passed, issues, reason }
review-redo      { round, issues }
```

前端 ChatContent 不需要立即消费这些事件（v1），但 TracePanel 会自动记录它们。

## 8. 与 Team Agent 的结合

Worker runAgent（runWorker 内部调用）会复用 agent.js 的完整循环 —— 所以如果 Worker 的 Agent 人设里 `review.enabled: true`，它自己跑完也会 review + 返工。这是免费的，不需要额外代码。

这也意味着：如果队长 review 开了但 Worker 人设没开 → Worker 不 review（Agent 级配置覆盖全局）。这符合 CrewAI "每个角色有自己的审查标准" 的直觉。

## 9. 失败兜底

- Critic 自身也会被 tool budget 限制（不开 tools 所以不会爆）
- Critic JSON 解析失败 → 默认 `passed: false`，但只追加一条 "无法自动判断，请人工复核" 的反馈（避免无限返工）
- redo 循环也会被 max-turns 兜底（redoMaxTurns = 原 maxTurns + 5）

## 10. 测试

新增 `packages/core/test/review.js`：
1. 正常完成 + enabled=true → Critic 被调用 1 次 + passed → 正常 finish
2. 正常完成 + enabled=true + Critic 不通过 → redo 再 review → 最终通过
3. 正常完成 + enabled=true + 永远不通过 → max_rounds 后正常 finish
4. max-turns 退出 → 跳过 review
5. abort → 跳过 review
6. enabled=false → 完全不触发
7. min_turns 门槛：只有 Read/Glob 还没动代码 → 跳过

既有测试集（test/asapi.js、test/memory.js、test/run.js）全部通过。
