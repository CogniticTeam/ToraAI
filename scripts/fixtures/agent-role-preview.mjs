import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const home = mkdtempSync(join(tmpdir(), 'tora-agent-role-preview-'));
process.env.TORA_HOME = home;
const port = Number(process.env.PORT || process.argv.slice(2).find(argument => /^\d+$/.test(argument)) || 3436), cloudPort = port + 1;
const base = `http://127.0.0.1:${cloudPort}`;
const { saveConfig } = await import('../../packages/core/src/config.js');
const { setModelFetcher } = await import('../../packages/core/src/model-transport.js');
const { createCredential } = await import('../../packages/core/src/asapi/store.js');
const { startASAPIServer } = await import('../../packages/core/src/asapi/server.js');
const models = ['role-model-a', 'role-model-b'].map((model, index) => ({ id: `role-fixture-${index}`, provider: 'custom', label: `Role model ${index + 1}`, model, baseURL: base + '/model/v1', apiKey: 'fixture-only', enabled: true }));
saveConfig({ modelList: models, model: models[0].model, baseURL: models[0].baseURL, apiKey: 'fixture-only', thinking: false, hooksEnabled: false, injectProjectContext: false });
createCredential({ type: 'openai_compatible', name: 'Agent Role fixture', base_url: models[0].baseURL, api_key: 'fixture-only' });
const requests = [];
const moderationRequests = [];
let moderationMode = 'allow';
const verification = { running: false, exitCode: null };
let verificationProcess;
setModelFetcher(async (_url, init) => {
  const body = JSON.parse(init.body);
  const system = body.messages?.find(message => message.role === 'system')?.content || '';
  if (system.startsWith('You are the Tora Agent Role content safety reviewer.')) {
    const role = JSON.parse(body.messages.find(message => message.role === 'user').content);
    moderationRequests.push({ model: body.model, role });
    if (moderationMode === 'unavailable') throw new Error('Isolated review provider unavailable');
    const verdict = { blocked_categories: moderationMode === 'blocked' ? ['pornography'] : [], companion: moderationMode === 'companion' };
    return Response.json({ choices: [{ message: { role: 'assistant', content: moderationMode === 'invalid' ? 'Invalid fixture verdict' : JSON.stringify(verdict) } }] });
  }
  const match = /Your name is ("(?:[^"\\]|\\.)*")\./.exec(system);
  const name = match ? JSON.parse(match[1]) : null;
  const personality = /Personality:\n([^\n]+)/.exec(system)?.[1];
  const instructions = /Role instructions:\n([^\n]+)/.exec(system)?.[1];
  requests.push({ model: body.model, system, tools: (body.tools || []).map(tool => tool.function.name) });
  const content = name ? `我是 ${name}。当前模型：${body.model}。${personality ? `性格：${personality}。` : ''}${instructions ? `设定：${instructions}。` : ''}` : '角色验证';
  return Response.json({ choices: [{ message: { role: 'assistant', content } }], usage: { prompt_tokens: 20, completion_tokens: 10 } });
});
const cloud = createServer((req, res) => {
  res.setHeader('access-control-allow-origin', '*');
  res.setHeader('access-control-allow-headers', 'content-type, authorization');
  res.setHeader('access-control-allow-methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
  const url = new URL(req.url, base);
  const path = url.pathname;
  if (path === '/fixture/moderation' && req.method === 'POST') {
    const mode = url.searchParams.get('mode');
    if (!['allow', 'companion', 'blocked', 'unavailable', 'invalid'].includes(mode)) {
      res.writeHead(400, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ error: 'Invalid fixture moderation mode' }));
    }
    moderationMode = mode;
  }
  if (path === '/fixture/moderation' && req.method === 'DELETE') moderationRequests.length = 0;
  if (path === '/fixture/requests' && req.method === 'DELETE') requests.length = 0;
  const data = path === '/auth/me' ? { id: 'agent-role-fixture', username: 'Agent Role preview', banned: false }
    : path === '/models' ? { models }
    : path === '/account/messages' ? { messages: [], unread: 0 }
    : path === '/account/events-ticket' ? { ticket: 'fixture' }
    : path === '/tochat/quota' ? { enabled: false, models: [] }
    : path === '/polls/config' ? { enabled: false, entryVisible: false }
    : path === '/fixture/requests' ? { requests }
    : path === '/fixture/moderation' ? { mode: moderationMode, requests: moderationRequests }
    : path === '/fixture/verification' ? verification
    : {};
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify(data));
});
const sockets = new Set();
cloud.on('upgrade', (req, socket) => {
  if (!req.headers['sec-websocket-key']) return socket.destroy();
  const accept = createHash('sha1').update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
  sockets.add(socket);
  socket.on('close', () => sockets.delete(socket));
  socket.on('error', () => sockets.delete(socket));
  socket.on('data', data => {
    if ((data[0] & 15) === 8) socket.end(Buffer.from([0x88, 0]));
    else socket.write(Buffer.from([0x81, 4, ...Buffer.from('pong')]));
  });
});
await new Promise(resolve => cloud.listen(cloudPort, '127.0.0.1', resolve));
const api = await startASAPIServer({ port });
console.log(`Agent Role preview ready at http://127.0.0.1:${port}; isolated auth and model fixtures at ${base}`);
if (process.argv.includes('--verify-core')) {
  verification.running = true;
  verificationProcess = spawn(process.execPath, ['--test',
    'packages/core/test/agent-roles.test.mjs', 'packages/core/test/catgirl.test.mjs',
    'packages/core/test/shared-work-history.test.mjs', 'packages/core/test/tocode-builtin.test.mjs',
    'packages/core/test/codex-subscription.test.mjs', 'packages/core/test/builtin-quota.test.mjs',
    'packages/core/test/tochat-mode.js', 'packages/core/test/asapi.js', 'packages/core/test/run.js',
  ], { stdio: 'inherit', env: { ...process.env, PATH: `${dirname(process.execPath)}:${process.env.PATH}` } });
  verificationProcess.once('exit', code => {
    verification.running = false;
    verification.exitCode = code;
    console.log(`Agent Role core verification finished with exit code ${code}`);
  });
}
const stop = () => {
  if (verification.running) verificationProcess?.kill('SIGTERM');
  for (const socket of sockets) socket.destroy();
  cloud.closeAllConnections?.(); api.closeAllConnections?.();
  Promise.all([new Promise(resolve => cloud.close(resolve)), new Promise(resolve => api.close(resolve))]).then(() => rmSync(home, { recursive: true, force: true }));
};
process.once('SIGTERM', stop);
process.once('SIGINT', stop);
