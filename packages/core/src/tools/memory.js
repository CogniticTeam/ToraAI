// 长期记忆工具族：MemorySave / MemorySearch / MemoryList / MemoryForget。
//
// 让模型把用户的稳定偏好、项目事实、踩坑教训存进跨会话记忆，下次会话
// 开场由 agent.js 注入系统提示（见 asapi/memory.js 的 renderMemoryContext）。
// 存储与去重/淘汰/评分都在 asapi/memory.js，本文件只做工具面的中文包装：
// 校验失败（MemoryValidationError）转提示字符串而非抛异常 —— 抛给模型的
// 应该是"怎么改"，不是堆栈。
//
// scope 推导：ctx.cwd 存在 → project_key = cwd，缺省 scope 为 project；
// 没有 cwd（CLI 直跑、无工作目录会话）→ project_key 为空，自动落 global。

import {
  saveMemory, searchMemories, listMemories, deleteMemory,
  projectKeyOf, MemoryValidationError, MEMORY_KINDS
} from '../asapi/memory.js';

const LIMIT_DEFAULT = 30;
const SEARCH_DEFAULT = 10;

/** 单条记忆的模型可读格式：完整 id（Forget 要精确匹配）+ 分类标签 + 内容。 */
function memLine(m) {
  const scope = m.scope === 'global' ? '全局' : `项目(${m.project_key || '?'})`;
  const tags = [m.kind, scope, m.pinned ? '置顶' : null].filter(Boolean).join('·');
  return `- #${m.id} [${tags}] ${m.content}`;
}

const scopeText = (scope) => (scope === 'global' ? '全局记忆' : '项目记忆');

export const memorySaveTool = {
  name: 'MemorySave',
  description:
    '把值得跨会话记住的信息存入长期记忆：用户偏好（preference）、项目事实（fact）、' +
    '踩坑教训（pitfall）、团队约定（convention）。写自包含短句（脱离上下文也能看懂），' +
    '相似内容会自动合并而不是新增。一次性的任务细节不要存。',
  parameters: {
    type: 'object',
    properties: {
      content: { type: 'string', description: `记忆内容（自包含短句，≤2000 字符）` },
      kind: { type: 'string', enum: MEMORY_KINDS, description: 'preference=偏好 / fact=事实 / pitfall=踩坑 / convention=约定，默认 fact' },
      scope: { type: 'string', enum: ['global', 'project'], description: 'global=所有项目通用；缺省为 project（绑定当前工作目录）' }
    },
    required: ['content']
  },

  async execute(args, ctx = {}) {
    const projectKey = projectKeyOf(ctx?.cwd);
    try {
      const { memory, deduped } = saveMemory({
        content: args?.content,
        kind: args?.kind ?? 'fact',
        scope: args?.scope,
        project_key: projectKey,
        source: 'tool'
      });
      const line = memLine(memory);
      return deduped
        ? `内容与已有记忆相似，已合并更新（未新增条目）：\n${line}`
        : `已存入${scopeText(memory.scope)}：\n${line}`;
    } catch (e) {
      if (e instanceof MemoryValidationError) return `保存失败：${e.message}`;
      throw e;
    }
  }
};

export const memorySearchTool = {
  name: 'MemorySearch',
  description:
    '按关键词检索长期记忆（中英文均可，返回按相关度排序）。' +
    '用户提到"之前/上次/还记得吗"，或新任务可能与历史偏好、教训相关时先查一下。',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: '检索关键词' },
      limit: { type: 'number', description: `最多返回条数，默认 ${SEARCH_DEFAULT}` }
    },
    required: ['query']
  },

  async execute(args) {
    const results = searchMemories(String(args?.query ?? ''), { limit: args?.limit ?? SEARCH_DEFAULT });
    if (!results.length) return `没有与「${String(args?.query ?? '').trim()}」相关的记忆。`;
    return [`找到 ${results.length} 条相关记忆：`, ...results.map(memLine)].join('\n');
  }
};

export const memoryListTool = {
  name: 'MemoryList',
  description:
    '列出长期记忆（缺省显示全局 + 当前项目，置顶在前）。' +
    '按关键词找用 MemorySearch；只想看某一范围时传 scope。',
  parameters: {
    type: 'object',
    properties: {
      scope: { type: 'string', enum: ['global', 'project'], description: '只看全局或只看当前项目；缺省两者都看' },
      limit: { type: 'number', description: `最多返回条数，默认 ${LIMIT_DEFAULT}` }
    }
  },

  async execute(args, ctx = {}) {
    const key = projectKeyOf(ctx?.cwd);
    const all = listMemories();
    let items;
    if (args?.scope === 'global') {
      items = all.filter((m) => m.scope === 'global');
    } else if (args?.scope === 'project') {
      items = key ? all.filter((m) => m.scope === 'project' && m.project_key === key) : [];
    } else {
      items = all.filter((m) => m.scope === 'global' || (key && m.scope === 'project' && m.project_key === key));
    }
    if (!items.length) return '这个范围还没有任何记忆。';
    const limit = Math.max(1, Math.min(Number(args?.limit) || LIMIT_DEFAULT, 100));
    const shown = items.slice(0, limit);
    const head = `共 ${items.length} 条${items.length > limit ? `（显示前 ${limit} 条，可用 limit 调大）` : ''}：`;
    return [head, ...shown.map(memLine)].join('\n');
  }
};

export const memoryForgetTool = {
  name: 'MemoryForget',
  description:
    '删除一条长期记忆（id 取自 MemoryList / MemorySearch 输出中 # 后的完整 id）。' +
    '仅在用户明确要求删除某条记忆时使用，不要自行清理。',
  parameters: {
    type: 'object',
    properties: { id: { type: 'string', description: '要删除的记忆 id（# 后的完整字符串）' } },
    required: ['id']
  },

  async execute(args) {
    const id = String(args?.id ?? '').trim();
    if (!id) return 'MemoryForget 需要 id（来自 MemoryList / MemorySearch 输出）。';
    const ok = deleteMemory(id);
    return ok
      ? `已删除记忆 ${id}。`
      : `没有 id 为「${id}」的记忆。请用 MemoryList 或 MemorySearch 核对后再试。`;
  }
};

export const memoryTools = [memorySaveTool, memorySearchTool, memoryListTool, memoryForgetTool];
