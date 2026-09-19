// 会话自动命名：AI 给对话取标题，仅第一轮触发一次。
//
// 设计约束（对齐"低 token 多干活"）：
//  - 一次最小请求：不流式展示、thinking 关闭、temperature 压低、输入截断到 400 字符；
//  - 失败静默降级为占位标题（首条消息截断），绝不打断聊天主流程；
//  - 生成后无论成败都锁定 naming.auto=false —— "仅第一次"由锁保证，
//    后续轮次不再重复烧 token。
import { createClient, chatCompletion } from './model.js';

/** 新会话默认标题（占位符）。 */
export const DEFAULT_TITLE = '新会话';

/** 占位标题：从用户原文截取前 24 字符（AI 标题就绪前后列表都有可读名称）。 */
export function placeholderTitle(text) {
  return String(text || '').slice(0, 24).replace(/\s+/g, ' ').trim();
}

/**
 * 清洗模型输出的标题：去引号/前缀/多行，24 字内收尾。
 */
function sanitize(raw) {
  if (!raw) return '';
  let t = String(raw).trim();
  t = t.split('\n')[0] || '';
  t = t.replace(/^[#>*\s]+/, '');
  t = t.replace(/^(标题|题目|题目：|Title)\s*[:：]?\s*/i, '');
  t = t.replace(/^["'“”「『【《]+/, '').replace(/["'“”」』】》]+$/, '');
  t = t.replace(/[。！？!?.]+$/, '');
  t = t.replace(/\s+/g, ' ').trim();
  if (t.length > 24) {
    const cut = t.slice(0, 24);
    const sep = Math.max(cut.lastIndexOf(','), cut.lastIndexOf('，'), cut.lastIndexOf('、'), cut.lastIndexOf(' '));
    t = sep >= 4 ? cut.slice(0, sep) : cut;
  }
  return t;
}

/**
 * 调用会话当前模型生成标题。失败/超时返回 null（调用方保留占位标题）。
 * @param {object} cfg resolveRunCfg/loadConfig 同源的模型配置
 * @param {{userText:string, assistantText?:string}} input
 */
export async function generateTitle(cfg, { userText, assistantText }) {
  const u = String(userText || '').slice(0, 400);
  if (!u.trim()) return null;
  const a = String(assistantText || '').slice(0, 400);
  try {
    const client = createClient({ ...cfg, temperature: 0.2, thinking: false });
    const { message } = await chatCompletion(client, {
      messages: [
        {
          role: 'system',
          content:
            '给下面的对话起一个简短标题：不超过12个字，概括主题，名词短语优先；' +
            '不要引号、书名号、句末标点，不要任何前缀或解释，只输出标题本身。使用对话所用的语言。'
        },
        { role: 'user', content: a ? `用户：${u}\n助手：${a}` : `用户：${u}` }
      ],
      signal: AbortSignal.timeout(20000)
    });
    const title = sanitize(message?.content);
    return title && title !== DEFAULT_TITLE ? title : null;
  } catch {
    return null;
  }
}
