# 结构化输出约束（Structured Output / JSON Schema）设计（v1）

- 日期：2026-09-18
- 状态：设计已确认，待实施
- 范围：让 Agent 最终回复（或工具返回值）能按 JSON Schema 强制约束；模型不支持原生 JSON mode 时自动重试 + 解析；不新增工具、不破坏现有纯文本回复能力
- 框架参考：PydanticAI / LangChain with_structured_output / Smolagents 结构化输出

---

## 1. 背景与目标

CoCode 的 Agent 最终回复是自由文本，工具返回值也是自由文本。这意味着：
- 想让 Agent 输出一个可被下游程序消费的 JSON（比如"列出项目依赖版本" → 返回 `{pkg: version}` 列表），用户必须在 prompt 里自己写 "请用 JSON 格式返回"，还经常不遵守
- Critic / 自动化规则如果想解析 Agent 的产出，必须自己做脆弱的文本解析

PydanticAI 的核心能力就是："给我一个 Pydantic 模型，我保证返回符合它的 JSON（不合法自动重试）"。CoCode 要的是同等级的结构化保证，但用 JSON Schema 做底层（零依赖，JSON Schema 已经是事实标准）。

## 2. 三种实现路径

**方案 A：agent.js 内置结构化输出层（推荐）**

在 runAgent 结束阶段，如果 `cfg.outputSchema` 存在：
1. 强制模型按 schema 输出（给额外 instruction + 不开 tools）
2. 用同一份 client 再发一次 chatCompletion
3. 解析 + 校验 JSON Schema（用 JSON Schema validator 库）
4. 不通过 → 自动重试 N 次，每次把校验错误喂回去
5. 通过了 → 把 JSON 当作最终输出事件 emit

**优点**：
- 与 review loop 同构（都是在 finish 前插一段，不干扰正常工具调用循环）
- 成本低：**预估 200-250 行**（agent.js 加 ~150 行 + 零依赖 schema validator 手写 ~80 行）
- 用户体验：AgentDialog / 设置里填一份 JSON Schema，所有会话自动按它输出

**缺点**：
- 模型可能"把正确答案塞进 JSON 里"而不是先想清楚再输出（对逻辑复杂的任务可能不是好事）
- v1 只支持 **最终回复** 结构化；工具返回值结构化留到 v2

---

**方案 B：StructuredOutput 工具**

让 Agent 主动调用 `StructuredOutput({schema, value})` 把结果结构化输出。类似 Smolagents 的 CodeAgent：模型"选择"自己要不要结构化。

**优点**：Agent 自主决定（逻辑复杂时选自由文本，结构化需求时选工具）
**缺点**：
- 和 Critic 工具同样的问题：依赖模型"记得"调用
- 和方案 A 比可靠性差得多

---

**方案 C：原生 JSON mode**

优先用 OpenAI compatible API 的 `response_format: { type: "json_schema", schema: {...} }`，如果模型不支持再回退到方案 A 的"prompt 强制 + 解析重试"。

**优点**：原生 JSON mode 稳定性最高（模型直接被 API 层约束）
**缺点**：
- 不是所有 provider 都支持 `response_format`（CoCode 卖点就是"任何 OpenAI 兼容"，不能假设有）
- 要做 provider capability 检测矩阵

---

**推荐：方案 A + 方案 C 结合（方案 C 失败时回退方案 A）**

具体：
1. 如果 client 支持 `response_format`（`client.supportsJsonSchema === true`），走**原生**（方案 C）
2. 不支持则走 **prompt 强制 + 解析重试**（方案 A）
3. 两种路径都用**同一份 JSON Schema validator**（手写 mini-validator，支持 object/array/string/number/boolean/enum/required + `additionalProperties: false`）

## 3. 已确认决策

| 决策点 | 结论 | 来源 |
|---|---|---|
| 触发方式 | Agent 级配置 `output_schema: JSONSchema` + 会话级覆盖 | 设计定 |
| 默认 | **空 schema** → 正常自由文本回复（不影响现有行为）| 设计定 |
| 与 review 共存 | review 先通过后再结构化（先审内容，再结构化表示） | 设计定 |
| JSON Schema 校验器 | 手写 mini-validator，覆盖高频 schema 关键词 | 零依赖 |
| 重试次数 | max_rounds: 2（默认）| 设计定 |
| 失败兜底 | 重试到 max_rounds 还过不了 → 发一条 `structured-output-failed` trace，正常 finish 自由文本 | 设计定 |

## 4. 文件清单

**修改**（2 个文件，约 350 行增量）：

| 文件 | 改动 |
|---|---|
| `packages/core/src/agent.js` | finish 前加 structured output 阶段（~200 行） |
| `packages/core/src/model.js` | client 加 `supportsJsonSchema` capability 字段（~30 行） |

**新增**（1 个文件，约 150 行）：

| 文件 | 行数 | 内容 |
|---|---|---|
| `packages/core/src/tools/schema-validator.js` | ~150 | 手写 JSON Schema validator（零依赖），支持 object/array/string/number/boolean/enum/required/additionalProperties |

**可选**：
- `AgentDialog.tsx` 加 SchemaForm 配置区（v1 不做，用户直接手写 JSON 填）

## 5. 核心流程（agent.js 尾部）

```js
// _runAgentImpl 尾部，review 之后
if (shouldRunStructuredOutput({ cfg, ... })) {
  await runStructuredOutput({ client, cfg, messages, emit, finish, trace });
} else {
  await finish('completed');
}
```

### 5.1 shouldRunStructuredOutput

```js
function shouldRunStructuredOutput({ cfg, exitReason }) {
  if (exitReason !== 'completed') return false;
  const schema = cfg.output_schema;
  if (!schema || typeof schema !== 'object') return false;
  // schema 至少要有 type 字段
  if (!schema.type) return false;
  return true;
}
```

### 5.2 runStructuredOutput 伪代码

```js
async function runStructuredOutput({ client, cfg, messages, emit, finish, trace }) {
  const schema = cfg.output_schema;
  const maxRounds = cfg.output_schema_max_rounds ?? 2;

  // 找到主 Agent 最终那条 assistant 文本（作为"要结构化的源内容"）
  const lastAssistantText = messages.filter(m => m.role === 'assistant')
    .map(m => contentToText(m.content)).join('\n');

  let round = 0;
  let result = null;

  while (round <= maxRounds) {
    round++;
    emit({ type: 'structured-start', round });

    const useNative = client.supportsJsonSchema;
    const completionMessages = buildStructuredMessages(messages, schema, lastAssistantText);

    const opts = { messages: completionMessages };
    if (useNative) opts.response_format = { type: 'json_schema', schema };

    const { message, usage } = await chatCompletion(client, opts);
    trace.request(`structured-${round}`, { useNative });
    trace.response(`structured-${round}`, { content: message.content, usage });

    // 尝试解析 + 校验
    const text = message.content || '';
    const jsonMatch = extractFirstJson(text);
    if (!jsonMatch) {
      result = { ok: false, errors: ['不是有效 JSON'] };
      emit({ type: 'structured-result', round, passed: false, errors: result.errors });
      if (round <= maxRounds) continue;
      break;
    }

    let parsed;
    try { parsed = JSON.parse(jsonMatch); }
    catch { result = { ok: false, errors: ['JSON 解析失败'] }; continue; }

    const validation = validateAgainstSchema(parsed, schema);
    if (validation.ok) {
      result = { ok: true, value: parsed };
      emit({ type: 'structured-result', round, passed: true });
      // emit 一条特殊事件，前端 ChatContent 可以渲染 JSON 卡片
      emit({ type: 'structured-output', value: parsed });
      messages.push({ role: 'assistant', content: JSON.stringify(parsed, null, 2) });
      return await finish('completed');
    }

    result = { ok: false, errors: validation.errors };
    emit({ type: 'structured-result', round, passed: false, errors: validation.errors });
  }

  // 到 max_rounds 还没过 → 发 failed 事件，正常 finish 自由文本
  emit({ type: 'structured-failed', errors: result?.errors });
  await finish('completed');
}
```

## 6. buildStructuredMessages

```js
function buildStructuredMessages(messages, schema, originalText) {
  // 1) 先加一条 system 指令
  const sys = `你必须严格按照以下 JSON Schema 输出。`
            + `只能返回一个合法的 JSON 对象，不要加额外解释文字、Markdown 代码块或前后缀。`;

  // 2) 把 schema 也喂进去
  const schemaMsg = `目标 JSON Schema：\n\`\`\`json\n${JSON.stringify(schema, null, 2)}\n\`\`\``;

  // 3) 把主 Agent 最终产出也喂进去（让 Critic/结构化"知道该结构化什么"）
  const contextMsg = `以下是你刚才任务的最终产出（供参考）：\n${originalText.slice(0, 4000)}`;

  return [
    { role: 'system', content: sys },
    { role: 'user', content: schemaMsg + '\n\n' + contextMsg },
    // 无 tools：结构化阶段不再调工具
  ];
}
```

## 7. validateAgainstSchema（手写 mini-validator）

**零依赖**，覆盖高频 schema 关键词：
- `type: 'string'` + `minLength` / `maxLength` / `pattern` / `format`（只校验 `email` / `url` / `date` / `date-time` 格式的基本正则）
- `type: 'number'` / `'integer'` + `minimum` / `maximum` / `multipleOf`
- `type: 'boolean'`
- `type: 'object'` + `properties` / `required` / `additionalProperties`
- `type: 'array'` + `items` / `minItems` / `maxItems`
- `enum: [...]`
- `const: value`
- `$ref` / `$defs` 不支持（v1，schema 要自包含）
- `oneOf` / `anyOf` / `allOf` 不支持

错误格式：`["/prop/key 必须是 string", "/prop/arr[0] 缺少必填字段 foo"]`（path 用 JSON Pointer 格式）。

## 8. config / Agent 配置

### Agent.data.output_schema

```json
{
  "name": "依赖版本查询 Agent",
  "data": {
    "output_schema": {
      "type": "object",
      "properties": {
        "dependencies": {
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "name": { "type": "string" },
              "version": { "type": "string" },
              "used_in": { "type": "array", "items": { "type": "string" } }
            },
            "required": ["name", "version"]
          }
        },
        "summary": { "type": "string" }
      },
      "required": ["dependencies", "summary"]
    },
    "output_schema_max_rounds": 2
  }
}
```

**优先级**：Agent 级 `output_schema` > 全局（默认空）。

### 会话级覆盖

`SessionConfig` 里加 `output_schema?: JSONSchema`（让用户可以临时在某个会话里开结构化）。v1 前端不暴露，可走 POST /sessions/:id 手动 patch。

## 9. Trace 事件

新增：
```
structured-start     { round }
structured-result    { round, passed, errors? }
structured-output    { value }        // 成功时 emit，给前端渲染
structured-failed    { errors }
```

## 10. 与 review loop 的交互顺序

```
runAgent 主循环（工具调用迭代）
  ↓
正常完成 → runReviewLoop → 通过
  ↓
runStructuredOutput → 通过
  ↓
finish('completed')
```

如果 review 不通过并触发了 redo → redo 完成后**重新 review + 重新 structured**。

## 11. 失败兜底

- JSON 不是合法 JSON → 加入重试
- JSON 合法但不通过 schema 校验 → 把校验错误作为 "上一轮的问题" 追加到 completionMessages 里重试
- max_rounds 后仍不通过 → emit structured-failed，finish 自由文本（保留 Agent 原本的文本输出）

## 12. 测试

新增 `packages/core/test/schema-validator.js`：
1. 简单 string schema 通过
2. required 缺失报 JSON Pointer 路径错误
3. additionalProperties=false 拒绝额外字段
4. enum 不在列表内报错
5. array items schema 校验每个元素

新增 `packages/core/test/structured-output.js`：
1. 正常会话 + Agent.output_schema → 结构化通过
2. 模型返回非 JSON → 重试成功
3. 永远不通过 → max_rounds 后 fail + 自由文本兜底
4. 不支持原生 JSON mode 的 client → prompt 强制 + 解析重试
5. 与 review 共存顺序正确
