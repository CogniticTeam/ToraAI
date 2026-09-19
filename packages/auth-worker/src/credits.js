// 模型积分消耗计算（从 index.js 抽出的纯函数模块，便于测试）。
// 与 packages/core/src/credit-rates.js 保持同步。

// ---------- 模型积分消耗倍率（与 packages/core/src/credit-rates.js 保持同步） ----------
// 仿 WorkBuddy 计费：积分消耗 =（有效输入 + 输出 token）× 模型档位单价 × 任务模式倍率 / 1000。
// 有效输入 = 非缓存输入 + 缓存命中输入 × 0.1（长上下文复用让利）。
// 倍率为平台内置定价，用户不可修改；档位单价取原输入/输出单价均值，总成本大致中性。
// 积分锚点：1 积分 ≈ ¥0.0085 模型采购成本。
export const MODEL_TIERS = {
  free:      { rate: 0   }, // 零消耗：余额门禁对免费档放行
  basic:     { rate: 0.2 },
  standard:  { rate: 0.4 },
  advanced:  { rate: 1.6 },
};
// 任务模式倍率：Ask（轻问答）打折，Craft（Agent 多步执行/工具调用）为基准价，
// Craft ≈ Ask 的 2.5 倍。客户端经 X-CoCode-Mode 头声明模式，缺省 craft。
export const MODE_RATES = { ask: 0.4, craft: 1 };
export const resolveModeRate = (mode) => MODE_RATES[String(mode || '').toLowerCase()] ?? MODE_RATES.craft;
export const MODEL_TIER_RULES = [
  { test: /glm-4\.6v-flash/i, tier: 'free' },
  { test: /glm-5\.3-flash|glm-4\.5-air/i, tier: 'basic' },
  { test: /deepseek-flash|deepseek-v4-flash/i, tier: 'standard' },
  { test: /deepseek-v4-pro|deepseek-r1/i, tier: 'advanced' },
];
export const ASR_RATE_PER_SECOND = 10;

export function resolveTier(model) {
  const name = String(model || '');
  for (const rule of MODEL_TIER_RULES) if (rule.test.test(name)) return rule.tier;
  return 'standard';
}
export function calcCredits(model, usage, mode) {
  if (!usage) return 0;
  const tier = MODEL_TIERS[resolveTier(model)];
  const prompt = usage.prompt_tokens || 0;
  const completion = usage.completion_tokens || 0;
  // 上游各家缓存字段格式不同（GLM: prompt_cache_hit_tokens；OpenAI:
  // prompt_tokens_details.cached_tokens；Anthropic: cache_read_input_tokens），
  // 网关拿到的是原始 usage，必须归一化后再计折扣——否则缓存输入被当全价
  // 扣费，与 core 展示口径（model.js 归一化后）对不上。
  const cached = Math.min(
    usage.cached_tokens
      ?? usage.prompt_tokens_details?.cached_tokens
      ?? usage.prompt_cache_hit_tokens
      ?? usage.cache_read_input_tokens
      ?? 0,
    prompt,
  );
  const modeRate = resolveModeRate(mode);
  // （非缓存输入 + 缓存×0.1 + 输出）× 档位单价 × 模式倍率
  const billableTokens = Math.max(0, prompt - cached) + cached * 0.1 + completion;
  return Math.max(0, Math.ceil((billableTokens * tier.rate * modeRate) / 1000));
}
export function calcAsrCredits(seconds) {
  const s = Number(seconds) || 0;
  return s > 0 ? Math.ceil(s * ASR_RATE_PER_SECOND) : 0;
}
