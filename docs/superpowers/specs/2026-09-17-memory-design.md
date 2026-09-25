# Memory 跨会话记忆系统设计（v1）

- 日期：2026-09-17
- 状态：设计已确认，待实施
- 范围：新增 agent 记忆子系统（存储 + 4 个工具 + 系统提示注入 + 可选提炼 + HTTP API + 设置 UI）；不改既有压缩、权限、SSE 逻辑

## 1. 背景与目标

CoCode 的 agent 每个会话都从零开始：用户的偏好（"回复用中文"）、项目事实（"这个仓库跑测试是 node packages/core/test/asapi.js"）、踩过的坑（"keystroke 发不了中文，要用 CGEventKeyboardSetUnicodeString"）每次都要重新告诉它。

本功能给 agent 一个**跨会话记忆**：平时靠模型主动调用工具存取，可选在会话结束时自动提炼；下一轮会话开始时，相关记忆自动注入系统提示。

## 2. 已确认决策

| 决策点 | 结论 | 来源 |
| --- | --- | --- |
| 记忆产生方式 | 工具为主（模型主动 Save/Search），提炼为**可选增强，默认关** | 用户选定 |
| 作用域 | **全局 + 项目两级**；schema 保留 scope 字符串字段便于未来加 agent 级 | 设计定 |
| 检索方式 | v1 纯本地评分（关键词 + 置顶加权 + 时间衰减），**不引入 embedding** | 设计定 |
| 存储 | 复用 store.js JSON 文件模式（原子写 + 损坏隔离），零新依赖 | 设计定 |

## 3. 数据模型与存储

新文件 `packages/core/src/asapi/memory.js`，存储于 `ASAPI_DIR`（`COCODE_DIR/asapi/`，`COCODE_DIR = COCODE_HOME || ~/.cocode`，测试重定向天然生效）：

- `memories.json`：`{ memories: [...] }`——在 memory.js 内**自行实现同一存储模式**（原子写 tmp+rename、损坏隔离 .corrupt-*），不触碰 store.js（其 readJson/writeJson 为模块私有，未导出）
- `memory-config.json`：`{ distill_enabled: false, inject_enabled: true }`（inject_enabled 预留记忆注入独立开关，v1 默认开、UI 不暴露）

每条记忆：

```json
{
  "id": "uuid",
  "created_at": "ISO",
  "updated_at": "ISO",
  "scope": "global | project",
  "project_key": "/abs/path 或空（global 时）",
  "kind": "preference | fact | pitfall | convention",
  "source": "tool | distill | manual",
  "pinned": false,
  "content": "一条自包含的短句"
}
```

关键规则：

1. **project_key = agent 运行时 cwd**（realpath 后的绝对路径，agent.js 已有此值；onCwdChange 后以新 cwd 为准）
2. **容量**：每个 scope（global 一份、每个 project_key 一份）上限 500 条；保存时超出则淘汰该 scope 内 `updated_at` 最旧的**非置顶**条目（全置顶时允许略超）
3. **去重合并**：MemorySave 时对该 scope 内（不限 kind）现有条目做归一化（小写、压空白）后计算字符 bigram Jaccard 相似度，≥ 0.85 视为同一条 → 更新 content/kind/updated_at，不新增（kind 以新值为准）

## 4. Agent 工具面

新文件 `packages/core/src/tools/memory.js`，导出 4 个工具（定义风格同 tasks.js：`{ name, description, parameters, ... }`，描述中文、错误返回中文提示字符串）。经 tools/builtin.js 注册。

| 工具 | 参数 | 行为 |
| --- | --- | --- |
| `MemorySave` | `content`（必填）、`kind?`（默认 fact）、`scope?`（默认：有 cwd → project，无 cwd → global） | 去重合并后写入；返回保存结果与当前 scope 条数 |
| `MemorySearch` | `query`（必填）、`limit?`（默认 10） | 本地评分排序，返回带 id 的条目列表 |
| `MemoryList` | `scope?`、`limit?`（默认 30） | 默认列 global + 当前 project；传 scope 则只列该 scope。按置顶 → updated_at 新→旧排列 |
| `MemoryForget` | `id`（必填） | 删除单条；返回剩余条数 |

检索评分（纯本地，`MemorySearch`）：query 分词（中英混合按空白 + 2-gram）后对每条 content 计算——

- 关键词/gram 命中数 × 2
- `pinned` × 3 加权
- 时间衰减：`updated_at` 越新加 0~1 分（30 天线性衰减）
- 得分为 0 的不入结果

**注入指引**：工具 description 里写清"什么时候该存"（用户明确表达偏好/纠正/项目事实时），避免模型滥用。

**权限归类（关键）**：4 个工具必须经 `toolCategory` 归为 **`'read'`**（tools/builtin.js）。否则未映射工具名默认归 `'execute'`，在 default 权限模式下每次调用都弹确认卡——模型会因反复被拦而回避这套工具，功能形同虚设。归 read 的理由：工具只写 CoCode 自己的数据目录（~/.cocode 下记忆库），不触碰用户工作目录与系统，风险等级同 TaskCreate（会话状态写），且内容在设置面板完全可见可删，用户控制权不受损。

## 5. 上下文注入

**集成点**：`agent.js` 中现有 `loadProjectContext(cwd)` 调用处（`injectProjectContext` 分支）——记忆与项目上下文同属"开局给模型的环境信息"，同点注入、同受 `injectProjectContext` 开关控制（另有 inject_enabled 独立开关，见第 3 节；v1 UI 不暴露）。

- 新增 `renderMemoryContext(cwd)`（放 memory.js）：拼装「置顶全部 + 当前 project + global」，**字符预算 6000（≈1500 token）**，超出按 置顶 > project > global、同级 updated_at 新→旧 截断
- 无记忆时返回空串、不加占位标题（不浪费 token）
- 挂入方式：agent.js 对 `buildSystemPrompt({...})` 的**返回值做字符串拼接**（记忆块追加到系统提示文本之后，prompt.js 与其入参均不变）；并在系统提示尾部追加一段**记忆使用指引**（何时存、何时查、Forget 的慎用说明）

## 6. 可选提炼（默认关）

触发：`bridge.js` chat run 结束处，判定 `doneReason === 'completed'` **且本轮存在助手回复**（blocked/max-turns/aborted/error 均不提炼；blocked 轮次可能没有助手回复可提炼），再查 `distill_enabled === true`：

1. 异步（fire-and-forget + catch 静默），不阻塞 SSE 收尾
2. 取本轮最后一条用户消息 + 助手回复（各截断到 ~2000 字符），用当前会话模型发起一次小调用，提示词要求输出 JSON 数组（0-3 条 `{content, kind}`，只提取"跨会话仍有价值"的信息：偏好/事实/教训/约定）
3. 逐条走与 MemorySave 相同的写入路径（去重合并，`source: 'distill'`）
4. 失败（模型调用、JSON 解析）一律静默跳过——提炼是增益不是承诺

模型不可用（未配 key）时整个提炼链路不启动。

## 7. HTTP API

新前缀 `/memories`、`/memory-config`（与 `/knowledge`、`/schedule` 风格平齐），**必须加入 server.js 的 `API_PREFIXES`**——否则无扩展名 GET 会被 serveStatic 吞掉返回 index.html（server.js 注释明确警告过这个坑）。路由用现有 `json() / apiError() / readBody()` 模式：

| 端点 | 行为 |
| --- | --- |
| `GET /memories?scope=&project_key=&q=` | 列表（q 走同一评分函数） |
| `POST /memories` | UI 手动创建，`source: 'manual'`；content 非空、kind/scope 白名单校验 |
| `PATCH /memories/:id` | 改 content/kind/scope/pinned |
| `DELETE /memories/:id` | 删除 |
| `GET /memory-config` / `POST /memory-config` | 读写 `distill_enabled` |

## 8. UI（设置对话框「记忆」标签页）

在现有设置窗口新增一个板块（与「使用统计」「智能体」同级）：

- 列表按 scope 分组（全局 / 各项目），条目显示 kind 徽标、置顶星标、source 来源、updated_at 相对时间
- 操作：搜索、新增、编辑、删除、置顶切换；提炼条目支持批量清理（按 source 过滤后多选删除）
- 顶部一个「会话结束自动提炼记忆」开关（写 /memory-config）
- 数据走 /memories API，操作后 refetch；不做实时 SSE 推送（记忆变更频率低，无需实时）

## 9. 错误处理

- JSON 损坏 → store.js 现有 .corrupt-* 隔离 + 空值 fallback，自动重建
- 工具异常（读写失败）→ 返回中文错误字符串（含"下一步建议"），不抛裸异常打断 ReAct 循环
- API 参数非法 → 400 + 具体字段说明（kind/scope 白名单、content 非空）
- 提炼失败 → 静默；写入失败不影响会话收尾

## 10. 测试计划

沿用 `packages/core/test/asapi.js` 模式（`COCODE_HOME` 重定向 + node:assert + 自写 test() helper）。新增 `packages/core/test/memory.js`，`npm test` 若有聚合入口则挂入（实施时确认 run.js 的组织方式）：

1. store 读写 / 损坏隔离 / COCODE_HOME 重定向
2. MemorySave 去重合并（相似句合并为一条、不同句新增）
3. 500 条上限淘汰（最旧非置顶先走、置顶豁免）
4. MemorySearch 评分排序（pinned 靠前、时间衰减、无关词零命中不返回）
5. 注入预算截断与优先级顺序（置顶 > project > global）
6. **权限归类断言**：4 个工具经 toolCategory 均返回 'read'（防默认 execute 弹确认卡的回归）
7. API 全 CRUD + 参数校验（400 路径）
8. 提炼：mock fetch 返回 JSON 数组 → 写入 source: 'distill'；失败静默；doneReason 非 completed 不触发

另用 `node --check` 验证新文件语法。

## 11. 非目标（v1 明确不做）

- 不做 embedding / 向量检索（本地评分够用，零依赖零成本）
- 不做 agent 级 scope（字段已预留）
- 不做记忆的跨设备同步
- 不做记忆冲突仲裁（去重合并已覆盖主要冲突场景）
- 不在聊天流里实时展示"正在记忆"卡片（UI 只在设置面板）

## 12. 未来扩展

- scope: "agent"（每个自定义 agent 独立记忆库）
- 设置面板加"记忆体检"（展示相近条目让用户手动合并）
- 提炼升级为按需总结整段会话而非仅最后两轮
