import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test, { after } from 'node:test';

const home = mkdtempSync(join(tmpdir(), 'tora-desktop-plugin-test-'));
process.env.TORA_HOME = home;

const { createDesktopPluginRegistry } = await import('../src/asapi/desktop-plugins.js');
const { startASAPIServer } = await import('../src/asapi/server.js');
const { isRunning } = await import('../src/asapi/bridge.js');
const { loadSessionRecord } = await import('../src/asapi/store.js');
const { saveConfig } = await import('../src/config.js');
const { buildMcpTools, stopAllMcpClients, stopMcpClient } = await import('../src/tools/mcp.js');

after(() => {
  stopAllMcpClients();
  rmSync(home, { recursive: true, force: true });
});

function sample(patch = {}) {
  return {
    schemaVersion: 1, id: 'handoff-fixture', name: 'Handoff fixture', version: '1.0.0',
    description: 'Plugin lifecycle test',
    skills: [{ name: 'handoff', description: 'Write a handoff', markdown: 'PLUGIN_FIXTURE_HANDOFF_INSTRUCTIONS' }],
    commands: [{ name: 'draft', description: 'Draft notes', body: 'Draft project notes.' }],
    ...patch,
  };
}

const localManifest = manifest => ({ type: 'file', label: 'tora.plugin.json', content: JSON.stringify(manifest) });
const registryIn = (name, options = {}) => createDesktopPluginRegistry({ directory: join(home, name), ...options });

test('manifests are inactive until enabled and keep their activation across restart', async () => {
  const registry = registryIn('lifecycle');
  const draft = await registry.preview(localManifest(sample()));
  assert.deepEqual(registry.list(), []);
  const installed = registry.install(draft.reviewId);
  assert.equal(installed.enabled, false);
  assert.deepEqual(registry.contributions(), { skills: [], commands: [] });

  registry.setEnabled(installed.id, installed.revision, true);
  const restarted = registryIn('lifecycle');
  const { skills, commands } = restarted.contributions();
  assert.equal(skills[0].name, 'handoff-fixture:handoff');
  assert.equal(commands[0].name, 'handoff-fixture:draft');
  assert.equal(commands[0].body, 'Draft project notes.');
  assert.match(restarted.skillContext([skills[0].id]), /PLUGIN_FIXTURE_HANDOFF_INSTRUCTIONS/);

  restarted.setEnabled(installed.id, installed.revision, false);
  assert.throws(() => restarted.skillContext([skills[0].id]), { code: 'pluginSkillUnavailable' });
  assert.deepEqual(restarted.contributions(), { skills: [], commands: [] });
  restarted.remove(installed.id, installed.revision);
  assert.deepEqual(registryIn('lifecycle').list(), []);
});

test('GitHub review pins what is installed and checks the previous manifest when replacing it', async () => {
  let remote = sample();
  let requests = 0;
  const registry = registryIn('github', {
    fetcher: async (url, options) => {
      requests++;
      assert.equal(url, 'https://raw.githubusercontent.com/fixture/tora/HEAD/tora.plugin.json');
      assert.equal(options.redirect, 'error');
      assert.equal(options.credentials, 'omit');
      return Response.json(remote);
    },
  });
  const first = await registry.preview({ type: 'github', url: 'https://github.com/fixture/tora' });
  remote = sample({ version: '1.1.0' });
  const beforeUpdate = registry.install(first.reviewId);
  assert.equal(requests, 1, 'Installing the reviewed copy does not download another payload');
  assert.equal(beforeUpdate.version, '1.0.0');
  registry.setEnabled(beforeUpdate.id, beforeUpdate.revision, true);
  const oldSkill = registry.contributions().skills[0];

  const update = await registry.preview({ ...beforeUpdate.source, expectedId: beforeUpdate.id });
  const samePrevious = await registry.preview({ ...beforeUpdate.source, expectedId: beforeUpdate.id });
  assert.equal(update.previous.version, '1.0.0');
  const installed = registry.install(update.reviewId);
  assert.equal(installed.version, '1.1.0');
  assert.equal(installed.enabled, false);
  assert.throws(() => registry.install(samePrevious.reviewId), { code: 'pluginChanged' });
  assert.equal((await registry.preview(beforeUpdate.source)).reviewId, null);
  registry.setEnabled(installed.id, installed.revision, true);
  assert.throws(() => registry.skillContext([oldSkill.id]), { code: 'pluginSkillUnavailable' });
  assert.match(registry.skillContext([registry.contributions().skills[0].id]), /PLUGIN_FIXTURE_HANDOFF_INSTRUCTIONS/);

  remote = sample({ id: 'different-id' });
  await assert.rejects(registry.preview({ ...beforeUpdate.source, expectedId: installed.id }), { code: 'sourceChanged' });
});

test('invalid manifests and unsupported networks are rejected before changing the registry', async () => {
  const registry = registryIn('validation', {
    fetcher: async () => { throw new Error('Invalid source should never reach the network'); },
  });
  await assert.rejects(registry.preview(localManifest(sample({ main: './setup.js' }))), { code: 'invalidManifest' });
  await assert.rejects(registry.preview(localManifest(sample({ schemaVersion: 2 }))), { code: 'unsupportedManifest' });
  await assert.rejects(registry.preview(localManifest(sample({ skills: [sample().skills[0], sample().skills[0]] }))), { code: 'invalidManifest' });
  await assert.rejects(registry.preview({ type: 'file', content: 'x'.repeat(257 * 1024) }), { code: 'manifestTooLarge' });
  await assert.rejects(registry.preview({ type: 'file', content: '{broken' }), { code: 'invalidJson' });
  for (const url of ['http://github.com/fixture/tora', 'https://127.0.0.1/tora.plugin.json', 'https://github.com@elsewhere.test/fixture/tora', 'https://raw.githubusercontent.com/fixture/tora/HEAD/tora.plugin.json?token=1']) {
    await assert.rejects(registry.preview({ type: 'github', url }), { code: 'invalidSource' });
  }
  assert.deepEqual(registry.list(), []);
});

function testMcpServer() {
  const { createInterface } = require('node:readline');
  const reply = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n');
  createInterface({ input: process.stdin }).on('line', line => {
    const { id, method, params } = JSON.parse(line);
    if (method === 'initialize') reply(id, { protocolVersion: '2024-11-05', capabilities: {}, serverInfo: { name: 'test', version: '1.0.0' } });
    if (method === 'tools/list') reply(id, { tools: [{ name: 'echo', inputSchema: { type: 'object', properties: {} } }] });
    if (method === 'tools/call') reply(id, { content: [{ type: 'text', text: `from ${process.argv[2]}: ${params.arguments.text}` }] });
  });
}

const serverFile = join(home, 'plugin-mcp-test.cjs');
writeFileSync(serverFile, `(${testMcpServer.toString()})()`);
const mcpServers = [{ name: 'echo', command: process.execPath, args: [serverFile, 'plugin'] }];

test('live MCP tools cannot reopen a disabled plugin or share its connection with ordinary servers', async () => {
  const registry = registryIn('mcp');
  const review = await registry.preview(localManifest(sample({ mcpServers })));
  const installed = registry.install(review.reviewId);
  assert.deepEqual(await registry.mcpTools(), []);
  registry.setEnabled(installed.id, installed.revision, true);
  const [pluginTool] = await registry.mcpTools();
  assert.match(pluginTool.name, /^mcp__tp_.+__echo$/);
  assert.equal(await pluginTool.execute({ text: 'one' }), 'from plugin: one');

  const sharedName = pluginTool.name.split('__')[1];
  const [ordinaryTool] = await buildMcpTools({ mcpServers: { [sharedName]: { command: process.execPath, args: [serverFile, 'ordinary'] } } });
  assert.equal(await ordinaryTool.execute({ text: 'two' }), 'from ordinary: two');
  registry.setEnabled(installed.id, installed.revision, false);
  assert.equal((await pluginTool.execute({ text: 'three' })).meta.failure.kind, 'plugin-disabled');
  assert.deepEqual(await registry.mcpTools(), []);
  assert.equal(await ordinaryTool.execute({ text: 'four' }), 'from ordinary: four');
  stopMcpClient(sharedName);
});

test('the Desktop ASAPI adds selected skills to model input and offers MCP only in work conversations', async t => {
  const requests = [];
  const provider = createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    requests.push(body);
    const names = body.tools?.map(tool => tool.function.name) || [];
    const last = body.messages.at(-1);
    const pluginTool = names.find(name => name.startsWith('mcp__tp_'));
    const action = names.includes('ToolSearch') && last.role === 'user'
      ? { name: 'ToolSearch', arguments: JSON.stringify({ query: 'echo', scope: 'integrations' }) }
      : pluginTool && last.tool_call_id === 'discover'
        ? { name: pluginTool, arguments: JSON.stringify({ text: 'found on demand' }) }
        : null;
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const delta = action ? { tool_calls: [{
      index: 0, id: action.name === 'ToolSearch' ? 'discover' : 'echo', function: action,
    }] } : { content: 'Test complete' };
    res.end(`data: ${JSON.stringify({ choices: [{ delta, finish_reason: action ? 'tool_calls' : 'stop' }] })}\n\ndata: [DONE]\n\n`);
  });
  await new Promise(resolve => provider.listen(0, '127.0.0.1', resolve));
  const close = server => {
    server.closeAllConnections();
    return new Promise(resolve => server.close(resolve));
  };
  t.after(() => close(provider));
  const model = 'deepseek-desktop-plugin-test';
  const modelConfig = { baseURL: `http://127.0.0.1:${provider.address().port}/v1`, apiKey: 'test-only', model };
  saveConfig({ ...modelConfig, modelList: [{ ...modelConfig, id: 'fixture', provider: 'custom', enabled: true }] });

  const registry = registryIn('asapi');
  const review = await registry.preview(localManifest(sample({ mcpServers })));
  const installed = registry.install(review.reviewId);
  registry.setEnabled(installed.id, installed.revision, true);
  t.after(() => registry.stopMcp());
  const selected = registry.contributions().skills[0].id;
  const server = await startASAPIServer({ port: 0, desktopPlugins: registry, desktopHarness: true });
  t.after(() => close(server));
  const base = `http://127.0.0.1:${server.address().port}`;
  const { agents } = await fetch(`${base}/agent/`).then(response => response.json());
  const agent = agents[0].id;
  const post = (path, body) => fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

  for (const mode of ['tocode', 'tochat']) {
    const { session_id: session } = await post('/sessions/', {
      agent_id: agent, application_mode: mode, task_mode: mode === 'tocode' ? 'work' : 'chat', model_source: 'custom',
      cwd: home, permission_mode: 'bypass',
      chat_model_config: { type: 'openai_compatible', credential_id: 'cocode-models', model, parameters: {} },
    }).then(response => response.json());
    const body = { agent_id: agent, session_id: session, view_mode: mode, selected_skill_ids: [selected], input: { content: [{ type: 'text', text: `Mode: ${mode}` }] } };
    const response = await post('/chat/', body);
    assert.equal(response.status, 200);
    const deadline = Date.now() + 6000;
    while (isRunning(session) && Date.now() < deadline) await delay(20);
    const request = requests.find(item => item.messages.some(message => message.role === 'user' && String(message.content).includes(`Mode: ${mode}`) && String(message.content).includes('PLUGIN_FIXTURE_HANDOFF_INSTRUCTIONS')));
    assert.ok(request, 'The host attaches the actual selected plugin instructions');
    assert.ok(!request.tools.some(tool => tool.function.name.startsWith('mcp__tp_')));
    assert.equal(request.tools.some(tool => tool.function.name === 'ToolSearch'), mode === 'tocode');
    if (mode === 'tocode') {
      const echo = requests.find(item => item.messages.at(-1)?.tool_call_id === 'echo');
      assert.ok(echo, 'Desktop can execute the discovered plugin tool');
      assert.equal(echo.messages.at(-1).content, 'from plugin: found on demand');
    }
    assert.doesNotMatch(JSON.stringify(loadSessionRecord(session).display), /PLUGIN_FIXTURE_HANDOFF_INSTRUCTIONS/);
    if (mode === 'tochat') {
      registry.setEnabled(installed.id, installed.revision, false);
      assert.equal((await post('/chat/', body)).status, 409);
    }
  }
});
