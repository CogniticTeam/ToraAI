import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after, before } from 'node:test';

const home = mkdtempSync(join(tmpdir(), 'tora-integrations-test-'));
process.env.TORA_HOME = home;
const { startASAPIServer } = await import('../src/asapi/server.js');
const { loadConfig, saveConfig } = await import('../src/config.js');
const { buildMcpTools, stopAllMcpClients } = await import('../src/tools/mcp.js');
const { getSkill, installSkill, loadSkillMarkdown, setSkillEnabled } = await import('../src/asapi/store.js');

let server;
let base;
before(async () => {
  server = await startASAPIServer({ port: 0 });
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => {
  stopAllMcpClients();
  server.closeAllConnections?.();
  await new Promise(resolve => server.close(resolve));
  rmSync(home, { recursive: true, force: true });
});

function request(path, method = 'GET', data) {
  return fetch(base + path, {
    method, ...(data === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(data) }),
  });
}

test('building and probing MCP honours persisted app switches and revokes old tool handles', async () => {
  const fixture = join(home, 'echo.cjs');
  const primaryStarted = join(home, 'primary-started');
  const otherStarted = join(home, 'other-started');
  writeFileSync(fixture, `
    const {createInterface}=require('node:readline');
    require('node:fs').writeFileSync(process.argv[2],'started');
    createInterface({input:process.stdin}).on('line',line=>{
      const {id,method,params}=JSON.parse(line);
      if(id===undefined)return;
      const result=method==='initialize'?{protocolVersion:'2024-11-05',capabilities:{},serverInfo:{name:'fixture',version:'1'}}:
        method==='tools/list'?{tools:[{name:'echo',inputSchema:{type:'object',properties:{}}}]}:
        {content:[{type:'text',text:params.arguments.text}]};
      process.stdout.write(JSON.stringify({jsonrpc:'2.0',id,result})+'\\n');
    });
  `);
  const def = marker => ({ command: process.execPath, args: [fixture, marker], env: { FIXTURE_TOKEN: 'fixture-only' } });
  saveConfig({ mcpServers: { legacy: def(otherStarted) } });
  const initial = await request('/mcp-workshop/servers').then(response => response.json());
  assert.equal(initial.servers[0].enabled, true);
  assert.equal(initial.servers[0].application, null);

  const app = { name: 'Project Archive', description: 'Local archive fixture', website: 'https://archive.example.invalid/' };
  const uri = '/mcp-workshop/servers/archive';
  const added = await request('/mcp-workshop/servers', 'POST', { name: 'archive', ...def(primaryStarted), enabled: false, application: app });
  assert.equal(added.status, 200);
  const newRow = await added.json();
  assert.deepEqual(newRow.application, app);
  assert.equal(newRow.env, undefined);
  assert.deepEqual(newRow.envKeys, ['FIXTURE_TOKEN']);
  assert.equal((await request(uri + '/probe', 'POST', {}).then(response => response.json())).status, 'disabled');
  assert.equal(existsSync(primaryStarted), false);
  assert.equal(existsSync(otherStarted), false);

  await request(uri, 'PATCH', { enabled: true, envPatch: { FIXTURE_REGION: 'local' } });
  assert.deepEqual(loadConfig().mcpServers.archive.env, { FIXTURE_TOKEN: 'fixture-only', FIXTURE_REGION: 'local' });
  const probed = await request(uri + '/probe', 'POST', {}).then(response => response.json());
  assert.equal(probed.status, 'ok');
  assert.deepEqual(probed.tools, ['echo']);
  assert.equal(existsSync(otherStarted), false, 'A single-server probe must not start its peers');
  const snapshot = { mcpServers: { archive: loadConfig().mcpServers.archive } };
  const [oldTool] = await buildMcpTools(snapshot);
  assert.equal(await oldTool.execute({ text: 'available' }), 'available');

  await request(uri, 'PATCH', { enabled: false });
  assert.equal(loadConfig().mcpServers.archive.enabled, false);
  assert.equal((await oldTool.execute({ text: 'stale' })).ok, false);
  assert.deepEqual(await buildMcpTools(snapshot), [], 'A stale child task cannot restart a disabled server');
  assert.equal((await request(uri + '/call', 'POST', { tool: 'echo', args: {} })).status, 400);

  await request(uri, 'PATCH', { application: null });
  const final = await request('/mcp-workshop/servers').then(response => response.json());
  const detached = final.servers.find(row => row.name === 'archive');
  assert.equal(detached.application, null);
  assert.equal(detached.enabled, false);
});

test('the skill switch persists and prevents a stale composer selection from submitting', async () => {
  const directory = join(home, 'notes-skill');
  mkdirSync(directory);
  writeFileSync(join(directory, 'SKILL.md'), '---\nname: notes-skill\ndescription: Fixture notes\n---\nSummarize notes.');
  const imported = await request('/skill/import-local', 'POST', { path: directory }).then(response => response.json());
  const skill = imported.skill;
  assert.equal(skill.enabled, true);
  const uri = '/skill/' + skill.id;
  assert.equal((await request(uri, 'PATCH', { enabled: 'false' })).status, 400);
  assert.equal((await request(uri, 'PATCH', { enabled: false }).then(response => response.json())).enabled, false);
  assert.equal(getSkill(skill.id).enabled, false);
  assert.match((await request(uri).then(response => response.json())).markdown, /Summarize notes/);

  const { agents } = await request('/agent/').then(response => response.json());
  const agent = agents[0].id;
  const { session_id } = await request('/sessions/', 'POST', { agent_id: agent }).then(response => response.json());
  const response = await request('/chat/', 'POST', { agent_id: agent, session_id, input: { content: [{ type: 'text', text: 'Fixture input' }] }, selected_skill_ids: [skill.id] });
  assert.equal(response.status, 409);
  assert.equal((await request(uri, 'PATCH', { enabled: true })).status, 200);
  assert.equal((await request('/skill').then(response => response.json())).find(row => row.id === skill.id).enabled, true);
});

test('late skill downloads keep enable changes and do not overwrite another install', async () => {
  const first = await installSkill({ name: 'download-fixture', hub_id: 'test', card_id: 'first' });
  let release;
  const markdown = loadSkillMarkdown(first.id, () => new Promise(resolve => { release = resolve; }));
  setSkillEnabled(first.id, false);
  release('Downloaded text');
  assert.equal(await markdown, 'Downloaded text');
  assert.equal(getSkill(first.id).enabled, false);

  let finish;
  const install = installSkill({ name: 'install-fixture', hub_id: 'test', card_id: 'second', fetchMarkdown: () => new Promise(resolve => { finish = resolve; }) });
  setSkillEnabled(first.id, true);
  finish('Installed text');
  await install;
  assert.equal(getSkill(first.id).enabled, true);
});
