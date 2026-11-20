// Run the desktop ASAPI execution path against the evaluator's synthetic workspace.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const prompt = process.argv[2];
const stateDirectory = process.env.TORA_HOME;
if (!prompt || !stateDirectory || !process.env.TORA_EVAL_RUN) {
  throw new Error('通过 eval-work-execution.mjs 启动桌面评测');
}

mkdirSync(stateDirectory, { recursive: true, mode: 0o700 });
const testCommand = process.env.TORA_EVAL_TEST_COMMAND || 'npm test';
const allowedCommands = ['pwd', 'ls', 'ls -la', testCommand];
const guardFile = join(stateDirectory, 'evaluation-tool-guard.cjs');
writeFileSync(guardFile, `
  const input = JSON.parse(require('node:fs').readFileSync(0, 'utf8'));
  if (!${JSON.stringify(allowedCommands)}.includes(String(input.tool_input?.command || '').trim())) {
    process.stdout.write(JSON.stringify({
      decision: 'deny',
      reason: '评测只允许查看当前目录和运行指定测试。用工作区内的 Read、Glob、Grep 查看文件。',
    }));
  }
`, { flag: 'wx', mode: 0o600 });
const shellQuote = value => "'" + value.replaceAll("'", "'\\''") + "'";
writeFileSync(join(stateDirectory, 'hooks.json'), JSON.stringify({
  PreToolUse: [{ matcher: 'Bash', command: `${shellQuote(process.execPath)} ${shellQuote(guardFile)}` }],
}), { flag: 'wx', mode: 0o600 });
writeFileSync(join(stateDirectory, 'config.json'), JSON.stringify({
  ...(process.env.TORA_EVAL_PROVIDER ? { provider: process.env.TORA_EVAL_PROVIDER } : {}),
  hooksEnabled: true,
  injectProjectContext: false,
  changesAware: false,
  repoMapInject: false,
  shellSandbox: true,
  shellNetworkAccess: false,
  permissionRules: [
    ...['Write', 'Edit'].map(tool_name => ({ tool_name, behavior: 'allow' })),
    ...allowedCommands.map(rule_content => ({ tool_name: 'Bash', rule_content, behavior: 'allow' })),
  ],
}), { flag: 'wx', mode: 0o600 });

const { loadConfig } = await import('../../packages/core/src/config.js');
const { registerSecretsFromConfig } = await import('../../packages/core/src/security.js');
const { startASAPIServer } = await import('../../packages/core/src/asapi/server.js');
const { isRunning } = await import('../../packages/core/src/asapi/bridge.js');
const { createSessionRecord, listAgents, loadSessionRecord, saveSessionRecord } = await import('../../packages/core/src/asapi/store.js');
const cfg = loadConfig();
registerSecretsFromConfig(cfg);
const agent = listAgents()[0];
const record = createSessionRecord({
  agent_id: agent.id, toraCfg: cfg, cwd: process.cwd(),
  chat_model_config: { type: 'openai_compatible', credential_id: '', model: cfg.model, parameters: {} },
});
record.config.naming = { auto: false };
record.config.application_mode = 'tocode';
record.config.task_mode = 'work';
// The non-interactive runner cannot answer approval cards. Bash still uses
// the local workspace sandbox and its disabled network policy in this mode.
record.state.permission_mode = 'dont_ask';
saveSessionRecord(record);

const server = await startASAPIServer({ desktopHarness: true, desktopMemory: true });
try {
  const response = await fetch(`http://127.0.0.1:${server.address().port}/chat/`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      session_id: record.id, agent_id: agent.id, view_mode: 'tocode',
      input: { role: 'user', content: [{ type: 'text', text: prompt }] },
    }),
  });
  if (!response.ok) throw new Error(`桌面 ASAPI 启动失败（HTTP ${response.status}）`);
  await response.arrayBuffer();
  while (isRunning(record.id)) await delay(25);
  const result = loadSessionRecord(record.id)?.display.at(-1);
  if (!result?.finished_reason) throw new Error('桌面 ASAPI 没有保存完整回复状态');
  if (result.error?.message) console.error(result.error.message);
  console.log(JSON.stringify({ model: cfg.model, finished_reason: result.finished_reason }));
} finally {
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}
