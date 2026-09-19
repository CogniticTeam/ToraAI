// 会话结束后的可选记忆提炼（Memory 批次5，设计见 docs/superpowers/specs/2026-09-17-memory-design.md）
// 语义：bridge.js 在 doneReason==='completed' 时 fire-and-forget 调用 distillAfterRun()。
// 任何失败（开关关闭 / 文本全空 / 模型不可用 / 超时 / JSON 不合法 / 单条校验失败）都静默跳过，
// 绝不影响正常收尾 —— 提炼是"锦上添花"，不是收尾链路的依赖。
import { createClient, chatCompletion } from '../model.js';
import { MEMORY_KINDS, loadMemoryConfig, saveMemory } from './memory.js';

const MAX_CHARS = 2000; // user / assistant 各自截断长度，防超长对话撑爆提示词

const SYSTEM_PROMPT = [
  '你是记忆提炼器。从对话中提取值得跨会话长期记住的信息。',
  '只输出一个 JSON 数组（0-3 条），每条形如 {"content":"...","kind":"fact|preference|pitfall|convention"}。',
  'kind 含义：preference=用户偏好，fact=项目/环境事实，pitfall=踩坑教训，convention=团队/项目约定。',
  '只记稳定可复用的内容（偏好、事实、教训、约定），忽略一次性任务细节与寒暄；没有就输出 []。',
  'content 用与对话相同的语言写一句陈述句。只输出 JSON，不要任何其他文字。'
].join('\n');

function clampText(s) {
  return String(s || '').slice(0, MAX_CHARS).trim();
}

// 容忍模型把 JSON 包进 ```json 围栏或夹带前后缀：截取首个 [ 到末个 ] 之间再解析
function parseMemories(raw) {
  if (!raw) return [];
  let text = String(raw).trim();
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) text = fence[1].trim();
  const start = text.indexOf('[');
  const end = text.lastIndexOf(']');
  if (start === -1 || end <= start) return [];
  const arr = JSON.parse(text.slice(start, end + 1));
  if (!Array.isArray(arr)) return [];
  const kinds = new Set(MEMORY_KINDS);
  return arr
    .filter((x) => x && typeof x.content === 'string' && x.content.trim() && kinds.has(x.kind))
    .slice(0, 3);
}

/** 提炼开关（默认关闭，配置白名单见 memory.js saveMemoryConfig） */
export function isDistillEnabled() {
  try { return loadMemoryConfig().distill_enabled === true; } catch { return false; }
}

/**
 * 从最后一轮对话提炼长期记忆；返回保存条数，任何失败返回 null（静默语义）。
 * @param {object} cfg resolveRunCfg 产物（含 baseURL/apiKey/model）
 * @param {{userText?:string, assistantText?:string, projectKey?:string}} input
 */
export async function distillFromRun(cfg, { userText, assistantText, projectKey } = {}) {
  const u = clampText(userText);
  const a = clampText(assistantText);
  if (!u && !a) return null;
  try {
    // 小调用封装与 title.js 同款：低温、关思考、20s 超时
    const client = createClient({ ...cfg, temperature: 0, thinking: false });
    const { message } = await chatCompletion(client, {
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: `【用户】\n${u || '（无）'}\n\n【助手】\n${a || '（无）'}` }
      ],
      signal: AbortSignal.timeout(20000)
    });
    const items = parseMemories(message?.content);
    let saved = 0;
    for (const item of items) {
      try {
        saveMemory({
          content: item.content.trim(),
          kind: item.kind,
          scope: projectKey ? 'project' : 'global',
          project_key: projectKey || '',
          source: 'distill'
        });
        saved += 1;
      } catch { /* 单条校验失败不拖累其余 */ }
    }
    return saved;
  } catch {
    return null;
  }
}

/**
 * bridge.js 收尾钩子入口：开关关闭时不发任何请求（可单测的行为守卫）。
 * 返回保存条数；调用方 fire-and-forget，不消费返回值。
 */
export async function distillAfterRun(cfg, { userText, assistantText, projectKey } = {}) {
  if (!isDistillEnabled()) return 0;
  return distillFromRun(cfg, { userText, assistantText, projectKey });
}
