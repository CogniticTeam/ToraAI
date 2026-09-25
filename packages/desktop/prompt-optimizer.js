// 提示词优化：DeepSeek deepseek-flash 云端改写。
//
//     渲染层（TextInput 工具栏 ✦ 按钮）→ IPC 'prompt-optimizer:run'
//     → 本模块 POST api.deepseek.com/chat/completions → 返回优化后的提示词。
//
// 放在主进程的原因：渲染层直连 DeepSeek 会被 CORS 拦截，主进程 fetch 无跨域限制。
// Key 不再硬编码（打进 asar 可被提取盗用），解析顺序：
//     1. 环境变量 DEEPSEEK_API_KEY；
//     2. 数据目录 `~/.cocode/.env`（COCODE_HOME 可重定向）里的
//        `DEEPSEEK_API_KEY=sk-...` 行。
// 关闭 thinking 模式：提示词改写是轻任务，思考链只会白白拖慢响应。

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const DEEPSEEK_URL = 'https://api.deepseek.com/chat/completions';
const MODEL = 'deepseek-flash';
const TIMEOUT_MS = 60_000;

/** 从环境变量或 ~/.cocode/.env 解析 API Key；都没有则返回 null。 */
function resolveApiKey() {
  const fromEnv = String(process.env.DEEPSEEK_API_KEY ?? '').trim();
  if (fromEnv) return fromEnv;
  const dir = process.env.COCODE_HOME || join(homedir(), '.cocode');
  try {
    const raw = readFileSync(join(dir, '.env'), 'utf8');
    for (const line of raw.split('\n')) {
      const m = line.match(/^\s*(?:export\s+)?DEEPSEEK_API_KEY\s*=\s*(.+?)\s*$/);
      if (m) {
        const v = m[1].replace(/^["']|["']$/g, '').trim();
        if (v) return v;
      }
    }
  } catch { /* 文件不存在/无权限都视为未配置 */ }
  return null;
}

const SYSTEM_PROMPT = [
      '你是提示词优化专家。用户会给你一段发给 AI 编程助手的原始提示词，你的唯一任务是把它扩写成一段更长、更详细、AI 更容易理解的提示词：',
      '- 忠实保留用户的原始意图、约束和细节，不增删需求本身',
      '- 主动补全关键上下文：目标、背景场景、期望产出、技术约束、可验收的标准',
      '- 把模糊的表述展开为具体、可执行的描述，逐步说明要做什么',
      '- 保持用户的语言（中文输入输出中文，英文输入输出英文）',
      '- 不要回答或执行任务本身，不要输出任何代码实现',
      '- 只输出优化后的提示词正文，不要任何解释、前缀、引号或代码块包裹',
    ].join('\n');

/**
 * 调 deepseek-flash 把一段原始提示词改写成优化版。
 * @param {string} text 用户当前输入的原始提示词
 * @returns {Promise<string>} 优化后的提示词文本
 * @throws {Error} 网络/超时/HTTP 错误，message 为可直接展示的中文说明
 */
export async function optimizePrompt(text) {
  const input = String(text ?? '').trim();
  if (!input) throw new Error('提示词为空，无法优化');

  const apiKey = resolveApiKey();
  if (!apiKey) {
    throw new Error('未配置提示词优化服务：请设置环境变量 DEEPSEEK_API_KEY，或写入 ~/.cocode/.env（一行 DEEPSEEK_API_KEY=sk-...）');
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  let res;
  try {
    res = await fetch(DEEPSEEK_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: MODEL,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: input },
        ],
        stream: false,
        thinking: { type: 'disabled' },
      }),
      signal: controller.signal,
    });
  } catch (err) {
    if (controller.signal.aborted) throw new Error(`优化请求超时（${TIMEOUT_MS / 1000}s），请重试`);
    throw new Error(`网络错误：${err?.message || err}`);
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    let detail = '';
    try {
      const body = await res.json();
      detail = body?.error?.message || '';
    } catch { /* 响应体非 JSON 时忽略，保留状态码即可 */ }
    throw new Error(`DeepSeek HTTP ${res.status}${detail ? `：${detail}` : ''}`);
  }

  const data = await res.json();
  const out = data?.choices?.[0]?.message?.content?.trim();
  if (!out) throw new Error('DeepSeek 返回了空结果，请重试');
  return out;
}
