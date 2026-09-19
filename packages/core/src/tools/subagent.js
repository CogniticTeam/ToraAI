// Subagent 工具：派一个子代理独立完成一项子任务。
//
// 这是"并行干活"的最小闭环：模型在一次回复里可以发多个工具调用，其中几条
// 是 Subagent —— 引擎已有的并行工具调用机制会让它们同时跑，各自拿回结果。
//
// 边界（都是刻意的，不要"改进"掉）：
//  · **子代理没有交互通道**。它继承主会话的权限规则，但模式按"只升不降"原则
//    压到 explore（除非主会话本来就是 bypass —— 用户已经明确说了什么都允许）。
//    原因：子代理的权限询问无法安全地接到主会话的确认卡片流上 —— 确认卡片
//    依赖"确认事件与 tool_call 块在同一事件流里按序到达"，子代理的事件不在这
//    条流里，接上去就是第八轮修过的"卡片不弹、调用永远 pending"那一类事故。
//    所以子代理是调研/分析/检索的并行手，写文件仍由主代理在用户眼皮底下做。
//  · **不可递归**：子代理的运行里不再注册 Subagent —— 防止指数爆炸。
//  · **过程不上屏**：子代理的文字流/工具调用不进主会话的事件流，只有最终
//    结果作为工具结果回来（工具卡片上显示"运行中"就是它活着的样子）。

import { runAgent } from '../agent.js';

const DEFAULT_CHILD_TURNS = 30;

/** 子代理兜一个摘要：最终文本 + 干了哪些活的统计（低 token）。 */
function summarizeChild(events, { toolOutputLimit }) {
  let text = '';
  let toolCalls = 0;
  let denied = 0;
  for (const e of events) {
    if (e.type === 'text-delta') text += e.text ?? '';
    else if (e.type === 'tool-start') toolCalls++;
    else if (e.type === 'tool-result' && e.ok === false) denied++;
  }
  text = text.trim();
  const stats = `（子代理：${toolCalls} 次工具调用${denied ? `，${denied} 次被拒` : ''}）`;
  if (!text) {
    return `子代理没有产出文本结果。${stats}`;
  }
  if (text.length > toolOutputLimit) {
    text = `${text.slice(0, toolOutputLimit)}\n…（子代理结果已截断，共 ${text.length} 字符）`;
  }
  return `${text}\n${stats}`;
}

export const subagentTool = {
  name: 'Subagent',
  description:
    '派一个子代理去独立完成一项自包含的子任务，返回它的最终结论。' +
    '适合可以并行拆分的调研/分析/检索：一次回复里发多个 Subagent 调用即可并行执行。' +
    '子代理有自己的独立上下文（不会污染主对话），过程不逐字上屏；' +
    '权限被限制在只读（explore）——写文件这类操作请留在主会话里做。' +
    'prompt 必须自包含：子代理看不到主对话，把背景、目标、验收标准一次写清。',
  parameters: {
    type: 'object',
    properties: {
      name: { type: 'string', description: '子代理的名字（2~24 字，用于结果标识，如「检索组」）' },
      prompt: {
        type: 'string',
        description: '给子代理的完整任务书：背景 + 目标 + 验收标准。它看不到主对话的任何内容。'
      }
    },
    required: ['prompt']
  },

  async execute(args, ctx = {}) {
    const prompt = String(args?.prompt ?? '').trim();
    if (!prompt) return 'Subagent 需要 prompt（子代理看不到主对话，任务书必须自包含）。';
    const name = String(args?.name ?? '').trim().slice(0, 24) || '子代理';
    if (ctx?.spawnDepth) {
      return '子代理里不能再派生子代理（防止递归失控）。请把要并行的工作写进同一份任务书里。';
    }
    const cfg = ctx?.cfg;
    if (!cfg) return 'Subagent 不可用：缺少运行配置。';

    // 权限只降不升：explore 是硬性只读契约；bypass 的主人已经明确授权，才跟着 bypass。
    const childMode = ctx?.permissionMode === 'bypass' ? 'bypass' : 'explore';
    const events = [];
    try {
      for await (const e of runAgent({
        cfg,
        cwd: ctx?.cwd ?? null,
        messages: [{ role: 'user', content: prompt }],
        signal: ctx?.signal ?? null,
        computerConsent: ctx?.computerConsent ?? null,
        permissionMode: childMode,
        maxTurns: Math.min(cfg.maxTurns ?? DEFAULT_CHILD_TURNS, DEFAULT_CHILD_TURNS),
        spawnDepth: 1,
        sessionId: ctx?.sessionId ?? null
      })) {
        events.push(e);
        if (e.type === 'done' && e.reason === 'aborted') {
          return `子代理「${name}」被中止。`;
        }
      }
    } catch (e) {
      return `子代理「${name}」运行失败：${e?.message || e}。可以自己接着做，或拆得更小再试一次。`;
    }
    const body = summarizeChild(events, { toolOutputLimit: ctx?.toolOutputLimit ?? 6000 });
    return `「${name}」的结果：\n${body}`;
  }
};

export const subagentTools = [subagentTool];
