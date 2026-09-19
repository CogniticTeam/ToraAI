// CoCode 套餐（Coding Plan / Token Plan / Agent Plan）接入目录。
//
// 调研结论（2026-09）：
// - 国内主流 Coding Plan（GLM/MiniMax/方舟/MiMo/腾讯/百炼）官方发放的都是
//   「套餐专属 API Key + 专用端点」，全部 OpenAI 兼容，没有面向第三方客户端
//   的 OAuth——用错端点（如方舟 /api/v3）会额外扣费甚至封号，所以专用端点
//   必须内置写死。
// - Agent Plan：目前仅方舟提供独立套餐（/api/plan/v3，以「智能体燃料 AFP」
//   统一计量），端点与 Key 均与 Coding Plan 不通用；MiniMax/腾讯/百炼为
//   统一 Token 套餐，编码与智能体场景共用同一额度，无需单独条目。
//   （智谱「龙虾套餐」为 OpenClaw 智能体场景限量套餐，走标准 paas 端点，
//   常年售罄，暂不收录。）
// - Qwen 曾有的 qwen.ai OAuth 免费层已于 2026-04-15 停用（官方 README 公告，
//   实测其 token 端点已被 WAF 405），因此 Qwen 走阿里云百炼 Coding Plan 的
//   DashScope 专用端点，与其它家统一为 API Key 模式。
// 数据流：套餐 Key 粘贴进来 → 走既有 /admin/models-config 落入 cfg.modelList →
//   LlmSelect / resolveRunCfg 完全复用，不改任何下游逻辑。
import { VEGA_DIR } from './config.js';

/** 套餐目录。url = 购买/申请页；keyUrl = 获取套餐 Key 的控制台页。
 *  models = 套餐内可用的默认模型清单（首条为推荐默认）。 */
export const PLAN_DEFS = [
  {
    key: 'glm-coding',
    name: '智谱 GLM Coding Plan',
    vendor: '智谱 AI',
    baseURL: 'https://open.bigmodel.cn/api/coding/paas/v4',
    keyUrl: 'https://bigmodel.cn/usercenter/proj-mgmt/apikeys',
    buyUrl: 'https://www.bigmodel.cn/glm-coding',
    note: '每月固定费用畅用 GLM 系列编程模型，按 5 小时周期刷新额度，注册后购买套餐并创建 Key 即可使用。',
    models: ['glm-4.7', 'glm-4.5-air'],
  },
  {
    key: 'zai-coding',
    name: 'Z.ai GLM Coding Plan（国际版）',
    vendor: 'Z.ai',
    baseURL: 'https://api.z.ai/api/coding/paas/v4',
    keyUrl: 'https://z.ai/manage-apikey/apikey-list',
    buyUrl: 'https://z.ai/subscription',
    note: '国际版 GLM 套餐，模型与国内版一致，支持国际支付方式，适合海外用户。',
    models: ['glm-4.7', 'glm-4.5-air'],
  },
  {
    key: 'minimax-coding',
    name: 'MiniMax Token Plan',
    vendor: 'MiniMax',
    baseURL: 'https://api.minimaxi.com/v1',
    keyUrl: 'https://platform.minimaxi.com',
    buyUrl: 'https://platform.minimax.io/subscribe/coding-plan',
    note: '统一 Token 套餐（Plus/Max/Ultra），编码与智能体（Agent）场景共用同一额度，畅用 MiniMax 旗舰模型，按 5 小时周期刷新，无需按量付费。',
    models: ['MiniMax-M3', 'MiniMax-M2.5', 'MiniMax-M2.1'],
  },
  {
    key: 'ark-coding',
    name: '字节 · 方舟 Coding Plan',
    vendor: '火山引擎',
    baseURL: 'https://ark.cn-beijing.volces.com/api/coding/v3',
    // 必须是 Coding Plan 场景的 API Key 页；普通方舟控制台的按量 Key 与此不通用
    keyUrl: 'https://ark.volcengine.com/region:cn-beijing/apikey',
    buyUrl: 'https://www.volcengine.com/activity/codingplan',
    note: '一个套餐可用豆包、DeepSeek、Kimi 等多款编程模型，额度每月刷新，性价比高。注意：需使用 Coding Plan 专属 API Key（在「获取 Key」页创建），与方舟按量计费的普通 API Key 不通用，Key 所属账号须已订阅本套餐。',
    models: ['doubao-seed-evolving', 'doubao-seed-2.1-turbo', 'kimi-k2.7-code', 'deepseek-v4-pro', 'minimax-m3'],
  },
  {
    key: 'ark-agent',
    name: '字节 · 方舟 Agent Plan',
    vendor: '火山引擎',
    baseURL: 'https://ark.cn-beijing.volces.com/api/plan/v3',
    // Agent Plan 场景的 API Key 页（openManagement 的 agentPlan 标签）；与 Coding Plan / 按量 Key 均不通用
    keyUrl: 'https://ark.volcengine.com/region:cn-beijing/openManagement?LLM=%7B%7D&OpenModelVisible=false&advancedActiveKey=agentPlan',
    buyUrl: 'https://www.volcengine.com/activity/agentplan',
    note: '面向智能体（Agent）场景的独立套餐，以「智能体燃料 AFP」统一计量，一个套餐可用豆包、GLM、DeepSeek、Kimi、MiniMax 等多款模型并支持联网搜索等 Agent 工具，40 元/月起，按 5 小时/月双周期刷新。注意：需使用 Agent Plan 专属 API Key（在「获取 Key」页的 Agent Plan 标签下创建），与 Coding Plan 及方舟按量计费的普通 Key 均不通用，Key 所属账号须已订阅本套餐。',
    models: ['doubao-seed-2.1-turbo', 'doubao-seed-evolving', 'deepseek-v4-pro', 'kimi-k3', 'minimax-m3', 'ark-code-latest', 'glm-5.3-flash', 'glm-latest', 'deepseek-v4.1-flash', 'deepseek-v4-flash', 'doubao-seed-2.0-lite', 'doubao-seed-2.0-mini', 'kimi-k2.7-code'],
  },
  {
    key: 'mimo-plan',
    name: '小米 MiMo Token Plan',
    vendor: '小米',
    baseURL: 'https://api.xiaomimimo.com/v1',
    keyUrl: 'https://www.xiaomimimo.com',
    buyUrl: 'https://www.xiaomimimo.com',
    note: '订阅后畅用小米 MiMo 系列模型，按 token 计量额度，适合日常编码辅助。',
    models: ['mimo-v2-pro', 'mimo-v2-omni', 'mimo-v2-flash'],
  },
  {
    key: 'tencent-plan',
    name: '腾讯 TokenHub Token Plan',
    vendor: '腾讯云',
    baseURL: 'https://api.lkeap.cloud.tencent.com/coding/v3',
    keyUrl: 'https://console.cloud.tencent.com/lkeap',
    buyUrl: 'https://console.cloud.tencent.com/lkeap',
    note: '已由 Coding Plan 升级为统一 Token 套餐（39 元/月起），编码与智能体（Agent）场景共用同一额度，畅用腾讯混元模型，国内访问稳定。',
    models: ['tc-code-latest', 'hunyuan-turbo'],
  },
  {
    key: 'qwen-coding',
    name: '阿里云百炼 Token Plan（Qwen）',
    vendor: '阿里云',
    baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    keyUrl: 'https://bailian.console.aliyun.com/?apiKey=1',
    buyUrl: 'https://www.aliyun.com/benefit-list/ai-programming',
    note: '统一 Token 套餐（团队版 198 元/月起），编码与智能体（Agent）场景共用额度，除通义千问系列外还覆盖 Kimi、GLM 等第三方模型，新用户有免费体验额度。',
    models: ['qwen3.6-plus', 'qwen3-coder-plus', 'qwen3-coder-flash'],
  },
];

export function getPlanDef(key) {
  return PLAN_DEFS.find((p) => p.key === key) || null;
}
