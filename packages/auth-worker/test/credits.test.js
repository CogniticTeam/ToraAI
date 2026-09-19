// 积分计算回归测试（无需 Cloudflare 环境：纯函数模块直测）
// 运行：node packages/auth-worker/test/credits.test.js
import { strict as assert } from 'node:assert';
import { calcCredits, calcAsrCredits, resolveTier } from '../src/credits.js';
// core 端显示口径（model.js 归一化后传给 calcCredits 的 usage 形态）：
// 扣费（worker）与展示（core）必须同源同值，否则用户看到的花费和实际扣的对不上。
import { calcCredits as coreCalcCredits } from '../../core/src/credit-rates.js';

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.error(`  ✗ ${name}\n    ${e.message}`); }
}

// deepseek-v4-pro = advanced（1.6），craft（1.0）：
// billable = (1000-800) + 800×0.1 + 200 = 480 → ceil(480×1.6×1/1000) = 1
// 若缓存折扣未生效：1200 token 全价 → ceil(1.92) = 2
const WITH_CACHE_DISCOUNT = 1;
const FULL_PRICE = 2;

console.log('--- 缓存字段归一化（上游各家私有格式都要吃到 0.1× 折扣） ---');
await test('OpenAI 风格 prompt_tokens_details.cached_tokens', async () => {
  const credits = calcCredits('deepseek-v4-pro', {
    prompt_tokens: 1000, completion_tokens: 200,
    prompt_tokens_details: { cached_tokens: 800 },
  }, 'craft');
  assert.equal(credits, WITH_CACHE_DISCOUNT);
});
await test('GLM 风格 prompt_cache_hit_tokens', async () => {
  const credits = calcCredits('deepseek-v4-pro', {
    prompt_tokens: 1000, prompt_cache_hit_tokens: 800, completion_tokens: 200,
  }, 'craft');
  assert.equal(credits, WITH_CACHE_DISCOUNT);
});
await test('Anthropic 风格 cache_read_input_tokens', async () => {
  const credits = calcCredits('deepseek-v4-pro', {
    prompt_tokens: 1000, completion_tokens: 200, cache_read_input_tokens: 800,
  }, 'craft');
  assert.equal(credits, WITH_CACHE_DISCOUNT);
});
await test('已归一化的顶层 cached_tokens（对照，不应回归）', async () => {
  const credits = calcCredits('deepseek-v4-pro', {
    prompt_tokens: 1000, cached_tokens: 800, completion_tokens: 200,
  }, 'craft');
  assert.equal(credits, WITH_CACHE_DISCOUNT);
});
await test('无缓存字段时按全价计费', async () => {
  const credits = calcCredits('deepseek-v4-pro', {
    prompt_tokens: 1000, completion_tokens: 200,
  }, 'craft');
  assert.equal(credits, FULL_PRICE);
});
await test('缓存数超过 prompt 时按 prompt 截断', async () => {
  const credits = calcCredits('deepseek-v4-pro', {
    prompt_tokens: 1000, cached_tokens: 2000, completion_tokens: 200,
  }, 'craft');
  // billable = 0 + 1000×0.1 + 200 = 300 → ceil(0.6) = 1
  assert.equal(credits, 1);
});

console.log('--- 与 core 展示口径一致（同一归一化 usage 两端结果相等） ---');
const usages = [
  { prompt_tokens: 1000, completion_tokens: 200, cached_tokens: 800 },
  { prompt_tokens: 5321, completion_tokens: 947, cached_tokens: 0 },
  { prompt_tokens: 100, completion_tokens: 5, cached_tokens: 30 },
];
const models = ['glm-5.3-flash', 'deepseek-flash', 'deepseek-v4-pro', 'unknown-model'];
const modes = ['ask', 'craft', undefined];
for (const model of models) for (const mode of modes) for (const usage of usages) {
  await test(`${model}/${mode ?? 'default'}`, async () => {
    assert.equal(calcCredits(model, usage, mode), coreCalcCredits(model, usage, mode));
  });
}

console.log('--- 档位与模式倍率 ---');
await test('档位规则与 core 同步', async () => {
  assert.equal(resolveTier('glm-4.6v-flash'), 'free');
  assert.equal(resolveTier('glm-5.3-flash'), 'basic');
  assert.equal(resolveTier('deepseek-flash'), 'standard');
  assert.equal(resolveTier('deepseek-v4-pro'), 'advanced');
  assert.equal(resolveTier('never-heard-of-it'), 'standard');
});
await test('免费档恒为 0（余额门禁放行）', async () => {
  assert.equal(calcCredits('glm-4.6v-flash', { prompt_tokens: 99999, completion_tokens: 99999 }, 'craft'), 0);
});
await test('ask 模式打 0.4 折', async () => {
  const usage = { prompt_tokens: 5000, completion_tokens: 1000 }; // craft: ceil(9.6)=10, ask: ceil(3.84)=4
  assert.equal(calcCredits('deepseek-v4-pro', usage, 'craft'), 10);
  assert.equal(calcCredits('deepseek-v4-pro', usage, 'ask'), 4);
});
await test('usage 缺失返回 0', async () => {
  assert.equal(calcCredits('deepseek-v4-pro', null, 'craft'), 0);
});

console.log('--- ASR 计费 ---');
await test('按秒向上取整', async () => {
  assert.equal(calcAsrCredits(3.2), 32);
  assert.equal(calcAsrCredits(0), 0);
  assert.equal(calcAsrCredits('abc'), 0);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
