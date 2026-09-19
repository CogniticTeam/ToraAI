# Memory 跨会话记忆系统实施计划

- 日期：2026-09-17
- 依据：[2026-09-17-memory-design.md](../specs/2026-09-17-memory-design.md)（已过独立审阅）
- 顺序：后端自底向上（存储 → 工具 → 注入 → API → 提炼），前端最后；每批次带验证，测试与实现同批交付

## 批次 1：存储层 `packages/core/src/asapi/memory.js`（新建）

自实现存储模式（不触碰 store.js，其 readJson/writeJson 为模块私有）：

```js
// 内部
readAll() / writeAll(memories)      // memories.json，原子写 tmp+rename，损坏隔离 .corrupt-*
normalize(str) / similarity(a, b)   // 归一化 + 字符 bigram Jaccard
enforceLimit(list, scope, projectKey) // 每 scope 500 上限，淘汰最旧非置顶
scoreOf(item, terms)                // 命中×2 + pinned×3 + 30天线性时间衰减
// 导出
listMemories() -> Memory[]
saveMemory({ content, kind, scope, project_key, source, pinned }) -> { memory, deduped }
updateMemory(id, patch) -> Memory | null
deleteMemory(id) -> boolean
searchMemories(query, { limit = 10 }) -> Memory[]
loadMemoryConfig() -> { distill_enabled: false, inject_enabled: true }
saveMemoryConfig(patch)
renderMemoryContext(cwd) -> string  // 「置顶全部+当前project+global」，6000字符预算截断；无记忆返回 ''
MEMORY_GUIDE                        // 系统提示用记忆使用指引常量
```

校验规则：kind ∈ {preference, fact, pitfall, convention}（默认 fact）、scope ∈ {global, project}、source ∈ {tool, distill, manual}、content 非空字符串（trim 后 ≤ 2000 字符，超长报错）。

**验证**：`node packages/core/test/memory.js`（新建，模式照抄 test/asapi.js：COCODE_HOME 重定向 + test() helper）——读写/损坏隔离/去重合并/500 淘汰/评分排序/renderMemoryContext 预算截断。

## 批次 2：工具 `packages/core/src/tools/memory.js`（新建）+ 注册

4 个导出（风格照 tasks.js：name/description/parameters + execute，中文描述）：

- `MemorySave(content, kind?, scope?)` —— cwd 取 `ctx.cwd`；无 cwd 时 scope 默认 global
- `MemorySearch(query, limit?)`
- `MemoryList(scope?, limit?)` —— 默认 global + 当前 project
- `MemoryForget(id)`

注册（tools/builtin.js）：

1. 加入内置工具表（4 个）
2. **`toolCategory` 映射：4 个全归 `'read'`**（审阅确认的关键点：漏掉则默认 'execute'，default 权限模式每次弹确认卡，功能不可用）

**验证**：`node --check` 三个文件 + 测试补断言：`toolCategory('MemorySave'|'MemorySearch'|'MemoryList'|'MemoryForget') === 'read'`。

## 批次 3：注入 `packages/core/src/agent.js`（修改）

在 buildSystemPrompt 调用处（L417 projectContext 组装分支附近）：

```js
// buildSystemPrompt({...}) 返回值之后字符串拼接（prompt.js 不动）
const memCfg = loadMemoryConfig();
if (cwd && cfg.injectProjectContext !== false && memCfg.inject_enabled) {
  const block = renderMemoryContext(cwd);
  if (block) systemPrompt += '\n\n' + block + '\n\n' + MEMORY_GUIDE;
}
```

**验证**：测试用例——有记忆时系统提示含记忆块与指引；无记忆时不追加任何占位；inject_enabled=false 时不注入；6000 字符预算截断（置顶 > project > global）。

## 批次 4：HTTP API `packages/core/src/asapi/server.js`（修改）

1. `API_PREFIXES` 加 `'/memories', '/memory-config'`（漏加则无扩展名 GET 被 serveStatic 吞掉返回 index.html）
2. 路由（json/apiError/readBody 现有模式）：

| 端点 | 行为 |
| --- | --- |
| `GET /memories?scope=&project_key=&q=` | 列表；q 走 searchMemories |
| `POST /memories` | source 强制 'manual'；400 校验 kind/scope/content |
| `PATCH /memories/:id` | 404 无此 id；可改 content/kind/scope/project_key/pinned |
| `DELETE /memories/:id` | 404 无此 id |
| `GET /memory-config`、`POST /memory-config` | distill_enabled / inject_enabled 白名单写入 |

**验证**：测试补 API 全 CRUD + 400 路径（非法 kind/scope、空 content）+ GET /memories 不返回 HTML。

## 批次 5：可选提炼 `packages/core/src/asapi/bridge.js`（修改）

chat run 收尾处（doneReason 判定点，L538-596 附近）：`doneReason === 'completed'` 且存在助手回复且 `loadMemoryConfig().distill_enabled` 时，`void distillFromRun(...).catch(() => {})`（fire-and-forget）：

- 取最后一条 user + assistant 消息（各截 2000 字符），调模型（参照 title.js 的独立小调用封装）提示词要求 JSON 数组 0-3 条 `{content, kind}`
- 逐条 `saveMemory({ ..., source: 'distill' })`（走同一去重/淘汰）
- 模型不可用/JSON 解析失败静默跳过

**验证**：测试 mock fetch 返回合法/非法 JSON 两条路径；doneReason 非 completed 不触发；distill_enabled=false 不触发。

## 批次 6：前端设置面板「记忆」板块

1. `src/api/types.ts`：MemoryData/MemoryRecord/MemoryConfig 类型
2. api 客户端：memories CRUD + memory-config 读写（沿现有 api 模块风格）
3. 设置对话框新增「记忆」板块（与「使用统计」「智能体」同级）：scope 分组列表、kind 徽标、置顶切换、搜索、增删改、提炼开关；distill 条目按来源过滤可批量删除；操作后 refetch（不做 SSE 实时）

**验证**：`npm run build`（tsc -b && vite build）零类型错误。

## 批次 7：全量回归

1. `node packages/core/test/memory.js` 全绿
2. `node packages/core/test/asapi.js` 全绿（既有回归）
3. 检查 test/run.js 聚合入口，挂入 memory 测试
4. `npm run build` 成功
5. `sudo xcodebuild -license` 未处理 → git 不可用，本次不 commit（与 CSP 修复同样留待用户）

## 风险与回退

- 每批次独立可回退（新增文件为主，agent.js/bridge.js/server.js 各一处小改动）
- 改动 agent.js / bridge.js / server.js 前备份到 `.claude/backups/`（用户规则：破坏性修改前备份）
