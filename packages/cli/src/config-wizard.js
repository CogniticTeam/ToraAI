// cocode config：交互式模型接入向导 + 连通性测试
import readline from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { loadConfig, saveConfig } from '../../core/src/config.js';
import { createClient, chatCompletion } from '../../core/src/model.js';
import { C } from './render.js';

async function ask(rl, question, def) {
  const suffix = def ? ` (${def})` : '';
  const ans = (await rl.question(`${question}${suffix}: `)).trim();
  return ans || def || '';
}

export async function runConfigWizard() {
  const cfg = loadConfig();
  const rl = readline.createInterface({ input: stdin, output: stdout });
  console.log(C.bold + '\nCoCode 模型接入向导' + C.reset + '（直接回车保留当前值）\n');
  try {
    console.log(C.dim + '支持任何 OpenAI 兼容接口：OpenAI / DeepSeek / 智谱 / Moonshot / Ollama / vLLM …' + C.reset);
    const baseURL = await ask(rl, '接口地址 baseURL', cfg.baseURL);
    const apiKey = await ask(rl, 'API Key（本地模型可留空）', cfg.apiKey ? '（保留原值）' : '');
    const model = await ask(rl, '模型名', cfg.model);

    const next = saveConfig({
      baseURL,
      apiKey: apiKey === '（保留原值）' ? undefined : apiKey,
      model
    });

    console.log(C.green + `\n✓ 已保存到 ~/.cocode/config.json` + C.reset);

    // 连通性测试
    const test = (await rl.question('现在测试连通性? [Y/n] ')).trim().toLowerCase();
    if (test !== 'n' && test !== 'no') {
      try {
        const client = createClient(next);
        const t0 = Date.now();
        const { message } = await chatCompletion(client, {
          messages: [{ role: 'user', content: '请只回复：pong' }]
        });
        console.log(C.green + `✓ 连通正常（${Date.now() - t0}ms）：${(message.content || '').slice(0, 30)}` + C.reset);
      } catch (e) {
        console.log(C.red + `✗ 测试失败：${e.message}` + C.reset);
        console.log(C.dim + '可稍后运行 `cocode config` 重试' + C.reset);
      }
    }
  } finally {
    rl.close();
  }
}

export function listConfig() {
  const cfg = loadConfig();
  console.log(`baseURL:  ${cfg.baseURL}
model:    ${cfg.model}
apiKey:   ${cfg.apiKey ? cfg.apiKey.slice(0, 6) + '…' + cfg.apiKey.slice(-4) : '（未设置）'}
budget:   ${cfg.maxTokensBudget} tokens（上下文治理阈值）`);
}
