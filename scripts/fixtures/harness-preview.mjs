import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const home = mkdtempSync(join(tmpdir(), 'tora-harness-preview-'));
process.env.TORA_HOME = home;
for (const key of ['TORA_API_KEY', 'OPENAI_API_KEY', 'TORA_BASE_URL', 'OPENAI_BASE_URL', 'TORA_MODEL']) delete process.env[key];
const port = Number(process.argv.slice(2).find(value => /^\d+$/.test(value)) || 3442), cloudPort = port + 1;
const cloudBase = `http://127.0.0.1:${cloudPort}`;
const { loadConfig, saveConfig } = await import('../../packages/core/src/config.js');
const { setModelFetcher } = await import('../../packages/core/src/model-transport.js');
const { createSessionRecord, listAgents, loadSessionRecord, saveSessionRecord } = await import('../../packages/core/src/asapi/store.js');
const { startASAPIServer } = await import('../../packages/core/src/asapi/server.js');
const modePath = join(home, 'fixture-mode.json');
writeFileSync(modePath, JSON.stringify({ mode: 'tasks' }));
const hookCode = `const fs=require('node:fs');const {mode}=JSON.parse(fs.readFileSync(${JSON.stringify(modePath)},'utf8'));process.stdout.write(JSON.stringify(mode==='blocked'?{decision:'deny',reason:'Harness 验收未通过：请处理后再继续。'}:{decision:'allow'}));`;
writeFileSync(join(home, 'hooks.json'), JSON.stringify({ Stop: [{ command: `${JSON.stringify(process.execPath)} -e ${JSON.stringify(hookCode)}` }] }));
const models = [{ id: 'harness-fixture', provider: 'custom', label: 'Harness 测试模型', model: 'harness-fixture', baseURL: cloudBase + '/model/v1', apiKey: 'fixture-only', enabled: true }];
saveConfig({ modelList: models, model: models[0].model, baseURL: models[0].baseURL, apiKey: 'fixture-only', thinking: false, hooksEnabled: true, injectProjectContext: false, forceReact: false, checkpointEnabled: false });
const agent = listAgents().find(item => item.builtin === 'covey');
const session = createSessionRecord({ agent_id: agent.id, name: 'Harness 执行验证', toraCfg: loadConfig(), chat_model_config: { type: 'openai_compatible', credential_id: 'cocode-models', model: models[0].model, parameters: { thinking: false } } });
Object.assign(session.config, { naming: { auto: false }, application_mode: 'tocode', task_mode: 'work', model_source: 'custom' });
session.state.permission_mode = 'accept_edits';
saveSessionRecord(session);
const requests = [], verification = { running: false, exitCode: null };
let pending = null, verifier = null;
const completion = message => Response.json({ choices: [{ message: { role: 'assistant', ...message } }], usage: { prompt_tokens: 20, completion_tokens: 10 } });
const action = (name, args, index) => ({ content: '', tool_calls: [{ id: `harness-${index}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }] });
setModelFetcher(async (_url, init) => {
  const body = JSON.parse(init.body), system = body.messages?.find(message => message.role === 'system')?.content || '';
  if (system.startsWith('You are the Tora Agent Role content safety reviewer.')) return completion({ content: '{"blocked_categories":[],"companion":false}' });
  if (!body.tools?.length) return completion({ content: 'Harness 执行验证' });
  requests.push({ model: body.model, tools: body.tools.map(tool => tool.function.name) });
  const { mode } = JSON.parse(readFileSync(modePath, 'utf8'));
  if (mode === 'blocked') return completion({ content: '本轮模型已尝试完成，等待配置的 Stop 验收。' });
  if (!body.tools.some(tool => tool.function.name === 'TaskCreate')) return completion({ content: '当前运行没有任务状态能力。' });
  const start = body.messages.findLastIndex(message => message.role === 'user');
  const results = body.messages.slice(start + 1).filter(message => message.role === 'tool');
  const id = /#(T\d+)/.exec(String(results[0]?.content || ''))?.[1];
  if (results.length && !id) return completion({ content: '任务创建失败，未声称成功。' });
  if (results.length === 0) return completion(action('TaskCreate', { subject: '核验真实任务状态', description: '在没有工作目录的会话中创建、推进并完成任务，验证持久化与恢复。' }, 1));
  if (results.length === 1) return completion(action('TaskUpdate', { taskId: id, state: 'in_progress' }, 2));
  if (results.length === 2) {
    return new Promise((resolve, reject) => {
      const abort = () => { if (pending?.abort === abort) pending = null;reject(Object.assign(Error('Fixture aborted'), { code: 'ABORTED' })); };
      pending = { abort, release() { init.signal?.removeEventListener('abort', abort);pending = null;resolve(completion(action('TaskList', {}, 3))); } };
      init.signal?.addEventListener('abort', abort, { once: true });
      if (init.signal?.aborted) abort();
    });
  }
  if (results.length === 3) return completion(action('TaskUpdate', { taskId: id, state: 'completed' }, 4));
  const current = loadSessionRecord(session.id)?.state.tasks_context?.tasks.find(task => task.id === id);
  return completion({ content: current?.state === 'completed' ? `任务 #${id} 已完成：任务状态已持久化，可刷新恢复，未执行任何工作区文件操作。` : '任务尚未完成，请检查工具返回结果。' });
});
const sockets = new Set();
const cloud = createServer((req, res) => {
  res.setHeader('access-control-allow-origin', '*');res.setHeader('access-control-allow-headers', 'content-type, authorization');res.setHeader('access-control-allow-methods', 'GET, POST, DELETE, OPTIONS');
  if (req.method === 'OPTIONS') { res.writeHead(204);return res.end(); }
  const url = new URL(req.url, cloudBase), path = url.pathname;
  if (path === '/fixture/mode' && req.method === 'POST') {
    const mode = url.searchParams.get('mode');
    if (!['tasks', 'blocked'].includes(mode)) { res.writeHead(400);return res.end('Invalid mode'); }
    writeFileSync(modePath, JSON.stringify({ mode }));
  }
  if (path === '/fixture/release' && req.method === 'POST') pending?.release();
  const data = path === '/auth/me' ? { id: 'harness-fixture', username: 'Harness preview', banned: false }
    : path === '/models' ? { models }
    : path === '/account/messages' ? { messages: [], unread: 0 }
    : path === '/account/events-ticket' ? { ticket: 'fixture' }
    : path === '/tochat/quota' ? { enabled: false, models: [] }
    : path === '/polls/config' ? { enabled: false, entryVisible: false }
    : path === '/fixture/session' ? { agentId: agent.id, sessionId: session.id }
    : path === '/fixture/status' ? { pending: !!pending, requests, state: loadSessionRecord(session.id)?.state, verification }
    : {};
  res.setHeader('content-type', 'application/json');res.end(JSON.stringify(data));
});
cloud.on('upgrade', (req, socket) => {
  if (!req.headers['sec-websocket-key']) return socket.destroy();
  const accept = createHash('sha1').update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
  sockets.add(socket);socket.on('close', () => sockets.delete(socket));socket.on('error', () => sockets.delete(socket));
  socket.on('data', bytes => (bytes[0] & 15) === 8 ? socket.end(Buffer.from([0x88, 0])) : socket.write(Buffer.from([0x81, 4, ...Buffer.from('pong')])));
});
await new Promise(resolve => cloud.listen(cloudPort, '127.0.0.1', resolve));
const api = await startASAPIServer({ port });
console.log(`Harness preview ready at http://127.0.0.1:${port}; isolated fixtures at ${cloudBase}`);
if (process.argv.includes('--verify-core')) {
  verification.running = true;
  verifier = spawn(process.execPath, ['--test', 'packages/core/test/harness-improvements.test.mjs', 'packages/core/test/harness-mcp.test.mjs', 'packages/core/test/asapi.js'], { stdio: 'inherit', env: { ...process.env, PATH: `${dirname(process.execPath)}:${process.env.PATH}` } });
  verifier.once('exit', code => { verification.running = false;verification.exitCode = code;console.log(`Harness verification finished with exit code ${code}`); });
}
const stop = () => {
  pending?.abort();if (verification.running) verifier?.kill('SIGTERM');
  for (const socket of sockets) socket.destroy();cloud.closeAllConnections?.();api.closeAllConnections?.();
  Promise.all([new Promise(resolve => cloud.close(resolve)), new Promise(resolve => api.close(resolve))]).then(() => rmSync(home, { recursive: true, force: true }));
};
process.once('SIGTERM', stop);process.once('SIGINT', stop);
