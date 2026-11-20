import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after } from 'node:test';
import { gzipSync } from 'node:zlib';

const home = mkdtempSync(join(tmpdir(), 'tora-desktop-discovery-'));
process.env.TORA_HOME = home;
const { createDesktopPluginRegistry } = await import('../src/asapi/desktop-plugins.js');
const { CONFIG_PATH, loadConfig } = await import('../src/config.js');
const { startASAPIServer } = await import('../src/asapi/server.js');
const { buildMcpTools, stopAllMcpClients } = await import('../src/tools/mcp.js');
const { setMcpHttpFetcher } = await import('../src/tools/mcp-http.js');
const { connectGithub, disconnectGithub, listServers, updateServer } = await import('../src/tools/mcp-workshop.js');

after(() => rmSync(home, { recursive: true, force: true }));

function packageEntry(name, content) {
  const body = Buffer.from(content);
  const header = Buffer.alloc(512);
  header.write(name);
  header.write(body.length.toString(8).padStart(11, '0'), 124);
  header[156] = 48;
  return Buffer.concat([header, body, Buffer.alloc((512 - body.length % 512) % 512)]);
}

test('a custom index can install a reviewed npm manifest from the chosen mirror', async () => {
  const manifest = {
    schemaVersion: 1, id: 'notes-fixture', name: 'Notes fixture', version: '1.0.0',
    description: 'Local fixture', commands: [{ name: 'notes', description: 'Notes', body: 'Summarize this conversation.' }],
  };
  const bytes = gzipSync(Buffer.concat([
    packageEntry('package/package.json', '{"scripts":{"postinstall":"exit 1"}}'),
    packageEntry('package/tora.plugin.json', JSON.stringify(manifest)),
    Buffer.alloc(1024),
  ]));
  const archive = 'https://registry.npmmirror.com/notes-fixture/-/notes-fixture-1.0.0.tgz';
  const indexUrl = 'https://cdn.jsdelivr.net/npm/tora-test/index.json';
  const index = {
    schemaVersion: 1, name: 'Team', plugins: [{
      id: manifest.id, name: manifest.name, category: 'Notes',
      source: { type: 'npm', spec: 'notes-fixture', registry: 'mirror' },
    }],
  };
  const paths = [];
  let integrity = 'sha512-' + createHash('sha512').update(bytes).digest('base64');
  const fetcher = async (url, options) => {
    assert.equal(options.credentials, 'omit');
    paths.push(url);
    if (url === indexUrl) return Response.json(index);
    if (url === 'https://registry.npmmirror.com/notes-fixture/latest') {
      return Response.json({ name: manifest.id, version: manifest.version, dist: { tarball: archive, integrity } });
    }
    if (url === archive) return new Response(bytes);
    throw new Error('Unexpected test endpoint');
  };
  const registry = createDesktopPluginRegistry({ directory: home, fetcher });
  await assert.rejects(registry.indexes.add('https://127.0.0.1/index.json'), { code: 'invalidIndex' });
  assert.deepEqual(paths, []);
  assert.deepEqual(await registry.indexes.add(indexUrl), { name: 'Team', url: indexUrl });
  const [entry] = (await registry.indexes.catalog(indexUrl)).plugins;
  assert.equal(entry.category, 'Notes');
  await assert.rejects(registry.preview({ ...entry.source, expectedId: 'other-plugin' }), { code: 'sourceChanged' });
  const review = await registry.preview({ ...entry.source, expectedId: entry.id });
  assert.deepEqual(registry.list(), []);
  assert.equal(registry.install(review.reviewId).enabled, false);
  const reopened = createDesktopPluginRegistry({ directory: home, fetcher });
  assert.equal(reopened.list()[0].source.registry, 'mirror');
  assert.equal(reopened.list()[0].source.version, '1.0.0');
  assert.equal(reopened.indexes.list()[0].url, indexUrl);
  integrity = 'sha512-' + Buffer.alloc(64).toString('base64');
  await assert.rejects(reopened.preview(entry.source), { code: 'packageIntegrity' });
  assert.equal(reopened.list().length, 1);
  reopened.indexes.remove(indexUrl);
  await assert.rejects(reopened.indexes.catalog(indexUrl), { code: 'invalidIndex' });
});

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`));
  });
}

async function close(server) {
  server.closeAllConnections?.();
  await new Promise(resolve => server.close(resolve));
}

const echo = { name: 'echo', inputSchema: { type: 'object', properties: {} } };
const initialization = { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1' } };
const rpc = (id, result) => ({ jsonrpc: '2.0', id, result });

test('MCP JSON is atomic and a remote server can be enabled, probed, used and revoked', async () => {
  const methods = [];
  let terminate;
  const deleted = new Promise(resolve => { terminate = resolve; });
  const remote = createServer(async (request, response) => {
    if (request.headers.authorization !== 'Bearer loopback-fixture') {
      response.writeHead(401).end();
      return;
    }
    if (request.method === 'DELETE') {
      if (request.headers['mcp-session-id'] === 'fixture-session') terminate();
      response.writeHead(204).end();
      return;
    }
    const parts = [];
    for await (const part of request) parts.push(part);
    const { method, id, params } = JSON.parse(Buffer.concat(parts));
    methods.push(method);
    if (method === 'initialize') {
      response.writeHead(200, { 'content-type': 'application/json', 'mcp-session-id': 'fixture-session' });
      response.end(JSON.stringify(rpc(id, initialization)));
      return;
    }
    if (request.headers['mcp-session-id'] !== 'fixture-session' || request.headers['mcp-protocol-version'] !== '2025-06-18') {
      response.writeHead(400).end();
      return;
    }
    if (method === 'notifications/initialized') {
      response.writeHead(202).end();
    } else if (method === 'tools/list') {
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      const reply = rpc(id, { tools: [echo] });
      response.write(`event: message\r\ndata: {\r\ndata: ${JSON.stringify(reply).slice(1)}\r\n\r\n`);
      response.end();
    } else if (method === 'tools/call') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify(rpc(id, { content: [{ type: 'text', text: params.arguments.text }] })));
    } else response.writeHead(400).end();
  });
  const url = await listen(remote);
  const asapi = await startASAPIServer({ port: 0 });
  const base = `http://127.0.0.1:${asapi.address().port}`;
  const send = (path, method = 'GET', body) => fetch(base + path, {
    method, ...(body ? { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } } : {}),
  });
  const importRows = mcpServers => send('/mcp-workshop/import', 'POST', { content: JSON.stringify({ mcpServers }) });
  const local = { command: process.execPath, args: ['--version'], enabled: true };
  const network = { type: 'http', url, headers: { Authorization: 'Bearer loopback-fixture' }, enabled: true };
  try {
    assert.equal((await importRows({ local, invalid: { url: 'http://example.org/mcp' } })).status, 400);
    assert.deepEqual(listServers(), []);
    const response = await importRows({ local, network });
    assert.equal(response.status, 200);
    assert.deepEqual((await response.json()).servers.map(server => [server.name, server.enabled]), [['local', false], ['network', false]]);
    assert.equal((await importRows({ other: local, local })).status, 409);
    assert.deepEqual(listServers().map(server => server.name), ['local', 'network']);
    assert.equal((await send('/mcp-workshop/servers/network/probe', 'POST', {}).then(result => result.json())).status, 'disabled');
    assert.deepEqual(methods, []);
    const summary = await send('/admin/runtime').then(result => result.json());
    assert.equal(summary.mcpServers.network.headers, undefined);
    await send('/admin/runtime', 'POST', { mcpServers: summary.mcpServers });
    assert.equal(loadConfig().mcpServers.network.headers.authorization, network.headers.Authorization);
    updateServer('network', { enabled: true });
    const options = { mcpServers: { network: loadConfig().mcpServers.network } };
    const [tool] = await buildMcpTools(options);
    assert.equal(tool.name, 'mcp__network__echo');
    assert.equal(await tool.execute({ text: 'from remote' }), 'from remote');
    assert.deepEqual(methods, ['initialize', 'notifications/initialized', 'tools/list', 'tools/call']);
    updateServer('network', { enabled: false });
    assert.equal((await tool.execute({ text: 'stale' })).ok, false);
    assert.deepEqual(await buildMcpTools(options), []);
    let timer;
    try {
      await Promise.race([deleted, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Expected session DELETE')), 2000); })]);
    } finally { clearTimeout(timer); }
    updateServer('network', { url: url + '/different' });
    assert.deepEqual(loadConfig().mcpServers.network.headers, {});
  } finally {
    stopAllMcpClients();
    await close(asapi);
    await close(remote);
  }
});

test('the GitHub connection validates a PAT before saving it and removes it on disconnect', async () => {
  const token = 'github-fixture-token';
  setMcpHttpFetcher(async (url, options) => {
    assert.equal(url, 'https://api.githubcopilot.com/mcp/');
    assert.equal(options.credentials, 'omit');
    assert.equal(options.redirect, 'error');
    if (options.headers.get('authorization') !== `Bearer ${token}`) return new Response(null, { status: 401 });
    const { id, method } = JSON.parse(options.body);
    if (method === 'initialize') return Response.json(rpc(id, initialization));
    if (method === 'notifications/initialized') return new Response(null, { status: 202 });
    return Response.json(rpc(id, { tools: [echo] }));
  });
  try {
    await assert.rejects(connectGithub('invalid-test-token'), /拒绝授权/);
    await assert.rejects(connectGithub(token, () => false), { status: 403 });
    assert.equal(loadConfig().mcpServers['github-app'], undefined);
    const server = await connectGithub(token);
    assert.equal(server.provider, 'github');
    assert.deepEqual(server.headerKeys, ['authorization']);
    assert.equal(JSON.stringify(listServers()).includes(token), false);
    assert.equal(statSync(CONFIG_PATH).mode & 0o077, 0);
    disconnectGithub();
    assert.equal(loadConfig().mcpServers['github-app'], undefined);
  } finally { setMcpHttpFetcher(); }
});
