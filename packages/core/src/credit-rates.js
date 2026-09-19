// CoCode 官方模型积分消耗倍率表（WorkBuddy 风格）
//
// 积分锚点：1 积分 ≈ ¥0.0085 的模型采购成本。
//   —— 即 100 积分 ≈ ¥0.85 模型成本，用户付 ¥1 订阅约对应 118 积分的成本价值，
//      留给开发者约 50-60% 毛利（扣除 6% 平台费后）。
//
// 消耗公式（文本模型，与 auth-worker 保持一致）：
//   消耗积分 =（有效输入 + 输出 token）× 模型档位单价 × 任务模式倍率 / 1000
//   有效输入 = 非缓存输入 + 缓存命中输入 × 0.1（鼓励长上下文复用）。
//   档位单价单位：积分 / 千 token；倍率为平台内置定价，用户不可修改。
//
// 任务模式（WorkBuddy 式差异化计费）：
//   Ask  ：轻问答，倍率 0.4；
//   Craft：Agent 多步执行 / 工具调用，倍率 1（≈ Ask 的 2.5 倍）。
//   客户端经 X-CoCode-Mode 头声明模式，缺省 craft。
//
// 消耗公式（语音识别 GLM-ASR）：
//   消耗积分 = 音频秒数 × asrRate（asrRate = 10 积分/秒）
//
// 倍率档位一览（单价取原输入/输出单价的均值，总成本大致中性）：
//   免费档  : 预留（GLM-4.6V-Flash）—— 0（零消耗，余额门禁放行）
//   基础档  : GLM-5.3-Flash —— 0.2
//   标准档  : DeepSeek-Flash / DeepSeek —— 0.4
//   高级档  : DeepSeek-Reasoner —— 1.6

/** 模型档位 → 积分消耗单价（积分 / 千 token） */
export const MODEL_TIERS = {
  free: {
    key: 'free',
    name: '免费档',
    rate: 0,
    desc: '预留档位，零积分消耗',
  },
  basic: {
    key: 'basic',
    name: '基础档',
    rate: 0.2,
    desc: 'GLM-5.3-Flash，性价比之选',
  },
  standard: {
    key: 'standard',
    name: '标准档',
    rate: 0.4,
    desc: 'DeepSeek-Flash / DeepSeek，日常编码主力',
  },
  advanced: {
    key: 'advanced',
    name: '高级档',
    rate: 1.6,
    desc: 'DeepSeek-Reasoner，深度推理',
  },
};

/** 任务模式倍率：Ask 打折、Craft 基准价（Craft ≈ Ask 的 2.5 倍） */
export const MODE_RATES = { ask: 0.4, craft: 1 };

/**
 * 解析任务模式倍率，未知值回退 craft。
 * @param {string} mode 'ask' | 'craft'
 * @returns {number} 模式倍率
 */
export function resolveModeRate(mode) {
  return MODE_RATES[String(mode || '').toLowerCase()] ?? MODE_RATES.craft;
}

/**
 * 模型名 → 档位匹配规则（与 auth-worker 的 OFFICIAL_CATALOG 保持同构）。
 * 按数组顺序匹配，命中即返回；都不命中回退到 standard。
 * 每条规则：{ test: RegExp, tier: key }
 */
export const MODEL_TIER_RULES = [
  { test: /glm-4\.6v-flash/i, tier: 'free' },
  { test: /glm-5\.3-flash|glm-4\.5-air/i, tier: 'basic' },
  { test: /deepseek-flash|deepseek-v4-flash/i, tier: 'standard' },
  { test: /deepseek-v4-pro|deepseek-r1/i, tier: 'advanced' },
];

/** 语音识别（GLM-ASR-2512）：10 积分/秒 */
export const ASR_RATE_PER_SECOND = 10;

/**
 * 根据模型名解析档位。
 * @param {string} model 模型名
 * @returns {keyof typeof MODEL_TIERS} 档位 key
 */
export function resolveTier(model) {
  const name = String(model || '');
  for (const rule of MODEL_TIER_RULES) {
    if (rule.test.test(name)) return rule.tier;
  }
  return 'standard'; // 未匹配默认标准档
}

/**
 * 获取模型的积分消耗单价。
 * @param {string} model 模型名
 * @returns {{rate:number, tier:string, name:string}}
 */
export function getCreditRate(model) {
  const tierKey = resolveTier(model);
  const tier = MODEL_TIERS[tierKey];
  return {
    tier: tierKey,
    name: tier.name,
    rate: tier.rate,
  };
}

/**
 * 计算一次模型调用消耗的积分。
 * @param {string} model 模型名
 * @param {{prompt_tokens:number, completion_tokens:number, cached_tokens?:number}} usage
 * @param {string} [mode] 任务模式：'ask' | 'craft'，缺省 craft
 * @returns {number} 消耗积分（向上取整，最少 0）
 */
export function calcCredits(model, usage, mode) {
  if (!usage) return 0;
  const { rate } = getCreditRate(model);
  const prompt = usage.prompt_tokens || 0;
  const completion = usage.completion_tokens || 0;
  const cached = usage.cached_tokens || 0;
  const modeRate = resolveModeRate(mode);
  // 有效输入 = 非缓存输入 + 缓存命中 × 0.1；再乘档位单价与模式倍率
  const billableTokens = Math.max(0, prompt - cached) + cached * 0.1 + completion;
  return Math.max(0, Math.ceil((billableTokens * rate * modeRate) / 1000));
}

/**
 * 计算语音识别消耗的积分。
 * @param {number} seconds 音频时长（秒）
 * @returns {number} 消耗积分
 */
export function calcAsrCredits(seconds) {
  const s = Number(seconds) || 0;
  if (s <= 0) return 0;
  return Math.ceil(s * ASR_RATE_PER_SECOND);
}

/**
 * 估算一次对话的积分消耗（用于前端展示"约 X 积分"）。
 * 按典型编程对话：10 万输入 + 2 万输出 token 估算，默认任务模式。
 * @param {string} model 模型名
 * @param {string} [mode] 任务模式，缺省 craft
 * @returns {number} 估算积分
 */
export function estimateCredits(model, mode) {
  return calcCredits(model, { prompt_tokens: 100000, completion_tokens: 20000 }, mode);
}
