import { test, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const home = mkdtempSync(join(tmpdir(), 'tora-codex-test-'));
process.env.TORA_HOME = home;
const auth = await import('../src/codex-auth.js');
const { setModelFetcher } = await import('../src/model-transport.js');
const { createClient, chatCompletion } = await import('../src/model.js');
const { resolveRunCfg } = await import('../src/asapi/bridge.js');
const { saveConfig } = await import('../src/config.js');

const jwt = value => `header.${Buffer.from(JSON.stringify(value)).toString('base64url')}.signature`;
const bundle = (extra = {}) => ({
  access_token: 'synthetic-access', refresh_token: 'synthetic-refresh', expires_in: 3600,
  id_token: jwt({ email: 'person@example.com', sub: 'user-fixture', 'https://api.openai.com/auth': { chatgpt_account_id: 'workspace-fixture' } }), ...extra,
});
const catalog = { models: [{ slug: 'fixture-codex', display_name: 'Fixture Codex', context_window: 200000, input_modalities: ['text', 'image'], supported_reasoning_levels: [{ effort: 'low' }, { effort: 'high' }] }] };
function mockAuth(extra, modelCatalog = catalog) {
  setModelFetcher(async (url, init) => {
    assert.equal(init.redirect, 'error');
    if (url.endsWith('/usercode')) return Response.json({ device_auth_id: 'private-device-id', user_code: 'ABCD-EFGH', interval: 1, expires_in: 900 });
    if (url.endsWith('/deviceauth/token')) return Response.json({ authorization_code: 'private-code', code_verifier: 'private-verifier' });
    if (url.endsWith('/oauth/token')) return Response.json(bundle());
    if (url.includes('/codex/models')) return Response.json(modelCatalog);
    return extra(url, init);
  });
}
async function connect() {
  const flow = await auth.startCodexLogin();
  await auth.pollCodexLogin(flow.flowId);
  await auth.fetchCodexModels();
  auth.saveCodexModels([{ model: 'fixture-codex', enabled: true }]);
  return flow;
}
const stream = events => new Response(new ReadableStream({ start(controller) {
  const bytes = new TextEncoder().encode(events.map(event => `data: ${JSON.stringify(event)}\r\n\r\n`).join(''));
  for (let i = 0; i < bytes.length; i += 7) controller.enqueue(bytes.slice(i, i + 7));
  controller.close();
} }), { headers: { 'content-type': 'text/event-stream' } });
const cfg = () => resolveRunCfg({ config: { model_source: 'custom', chat_model_config: { type: auth.CODEX_PROVIDER, credential_id: auth.CODEX_CREDENTIAL_ID, model: 'fixture-codex' } } });
afterEach(() => { auth.disconnectCodex(); auth.setCodexStorage(null); setModelFetcher(null); });
after(() => rmSync(home, { recursive: true, force: true }));

test('device login keeps credentials private and registers a separate model identity', async () => {
  mockAuth();
  const flow = await connect();
  assert.equal(flow.verificationUrl, 'https://auth.openai.com/codex/device');
  assert.ok(!JSON.stringify(flow).includes('private-device-id'));
  const status = auth.codexStatus();
  assert.equal(status.connected, true);
  assert.equal(status.storage, 'memory');
  assert.equal(status.models[0].model, 'fixture-codex');
  assert.equal(auth.codexModelCards()[0].context_size, 200000);
  assert.ok(!JSON.stringify(status).includes('synthetic-'));
  saveConfig({ modelList: [{ model: 'fixture-codex', provider: 'custom', enabled: true, baseURL: 'https://other.invalid', apiKey: 'other-secret' }] });
  assert.equal(cfg().provider, auth.CODEX_PROVIDER);
  assert.equal(cfg().apiKey, '');
  auth.disconnectCodex();
  assert.throws(cfg, /连接|登录/);
});

test('Codex uses its advertised 1M maximum for cards and runtime despite a smaller default or stale selection', async () => {
  mockAuth(undefined, { models: [{ ...catalog.models[0], context_window: 272000, max_context_window: 1050000, max_output_tokens: 128000 }] });
  await connect();
  assert.equal(auth.codexModelCards()[0].context_size, 1050000);
  assert.equal(auth.codexModelCards()[0].output_size, 128000);
  const run = resolveRunCfg({ config: { model_source: 'custom', chat_model_config: { type: auth.CODEX_PROVIDER, credential_id: auth.CODEX_CREDENTIAL_ID, model: 'fixture-codex', parameters: { contextWindow: '300k', contextSize: 128000 } } } });
  assert.equal(run.maxTokensBudget, 1050000 - 128000 - 8192);
});

test('Codex accepts maximum-only metadata without inflating smaller or unknown models to 1M', async () => {
  for (const [metadata, expected] of [
    [{ max_context_window: 1000000 }, 1000000],
    [{ context_window: 200000, max_context_window: 320000 }, 320000],
    [{ context_window: 200000, max_context_window: 0 }, 200000],
    [{ context_window: 200000, max_context_window: 10000001 }, 200000],
    [{ context_window: 200000, max_context_window: 'invalid' }, 200000],
    [{ context_window: 200000 }, 200000],
    [{}, 128000],
  ]) {
    mockAuth(undefined, { models: [{ ...catalog.models[0], context_window: undefined, ...metadata }] });
    await connect();
    assert.equal(auth.codexModelCards()[0].context_size, expected);
    assert.equal(cfg().maxTokensBudget, expected - 16384 - 8192);
  }
});

test('Codex cards distinguish declared reasoning levels from compatibility fallbacks, including after reload', async () => {
  const { codexRequestBody } = await import('../src/codex.js');
  const storage = { encrypt: text => Buffer.from(text).toString('base64'), decrypt: text => Buffer.from(text, 'base64').toString() };
  const fixtures = [
    { slug: 'undeclared', levels: undefined },
    { slug: 'empty', levels: [] },
    { slug: 'unrecognized', levels: ['turbo'] },
    { slug: 'default-only', levels: undefined, default_reasoning_level: 'high' },
    { slug: 'string-levels', levels: ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'minimal', 'turbo'], expected: ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'], default: 'high' },
    { slug: 'object-levels', levels: [{ effort: 'none' }, { effort: 'minimal' }, { effort: 'max' }, { effort: 'turbo' }], expected: ['none', 'minimal', 'max'], default: 'max' },
    { slug: 'none-only', levels: ['none'], expected: ['none'], default: 'none' },
    { slug: 'minimal-only', levels: [{ effort: 'minimal' }], expected: ['minimal'], default: 'minimal' },
  ];
  auth.setCodexStorage(storage);
  mockAuth(undefined, { models: fixtures.map(({ slug, levels, default_reasoning_level }) => ({ slug, supported_reasoning_levels: levels, default_reasoning_level })) });
  const flow = await auth.startCodexLogin();
  await auth.pollCodexLogin(flow.flowId);
  const fetched = await auth.fetchCodexModels();
  auth.saveCodexModels(fixtures.map(value => ({ model: value.slug, enabled: true })));
  for (const fixture of fixtures) {
    const model = fetched.models.find(value => value.id === fixture.slug);
    assert.equal(model.effortsDeclared, !!fixture.expected, fixture.slug);
    assert.deepEqual(model.efforts, fixture.expected || ['low', 'medium', 'high'], fixture.slug);
  }
  const beforeReload = auth.codexModelCards();
  auth.setCodexStorage(storage);
  assert.deepEqual(auth.codexModelCards(), beforeReload, 'Persisting runtime fallback levels must not turn them into declared capabilities');
  for (const fixture of fixtures) {
    const properties = auth.codexModelCards().find(value => value.name === fixture.slug).parameter_schema.properties;
    assert.deepEqual(properties, fixture.expected
      ? { thinkingEffort: { type: 'string', enum: fixture.expected, default: fixture.default } } : {}, fixture.slug);
    const run = resolveRunCfg({ config: { model_source: 'custom', chat_model_config: { type: auth.CODEX_PROVIDER, credential_id: auth.CODEX_CREDENTIAL_ID, model: fixture.slug } } });
    assert.equal(codexRequestBody(createClient(run), [], []).reasoning.effort, fixture.default || 'high');
    if (!fixture.expected) {
      for (const level of ['low', 'medium', 'high']) {
        assert.equal(codexRequestBody(createClient({ ...run, thinkingEffort: level }), [], []).reasoning.effort, level, 'Undeclared catalogs retain the old runtime fallback without advertising it');
      }
    }
  }
});

test('every advertised Codex effort survives persisted parameters, codexRequestBody and the actual mocked request unchanged', async () => {
  const { codexRequestBody } = await import('../src/codex.js');
  const { createSessionRecord, loadSessionRecord, saveSessionRecord } = await import('../src/asapi/store.js');
  const levels = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
  mockAuth(undefined, { models: [{ ...catalog.models[0], supported_reasoning_levels: levels.map(effort => ({ effort })) }] });
  await connect();
  const properties = auth.codexModelCards()[0].parameter_schema.properties;
  assert.deepEqual(properties, { thinkingEffort: { type: 'string', enum: levels, default: 'high' } });
  const record = createSessionRecord({ agent_id: 'reasoning-fixture', chat_model_config: { type: auth.CODEX_PROVIDER, credential_id: auth.CODEX_CREDENTIAL_ID, model: 'fixture-codex', parameters: {} }, cwd: home });
  const selections = [
    ...properties.thinkingEffort.enum.map(thinkingEffort => ({ parameters: { thinkingEffort }, expected: thinkingEffort })),
    { parameters: {}, expected: 'high' },
    { parameters: { thinking: false, thinkingEffort: 'high' }, expected: 'none' },
  ];
  for (const { parameters, expected } of selections) {
    record.config.chat_model_config.parameters = parameters;
    saveSessionRecord(record);
    const restored = loadSessionRecord(record.id);
    assert.deepEqual(restored.config.chat_model_config.parameters, parameters);
    const run = resolveRunCfg(restored);
    assert.equal(run.thinkingEffort, parameters.thinkingEffort, 'Persisted none/minimal must not be aliased to low');
    const client = createClient(run);
    assert.equal(codexRequestBody(client, [], []).reasoning.effort, expected);
    const requests = [];
    setModelFetcher(async (url, init) => {
      assert.equal(url, auth.CODEX_BASE_URL + '/responses');
      requests.push(JSON.parse(init.body));
      return Response.json({ object: 'response', status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: 'fixture response' }] }] });
    });
    assert.equal((await chatCompletion(client, { messages: [{ role: 'user', content: 'Check the selected effort.' }] })).message.content, 'fixture response');
    assert.equal(requests.length, 1, 'An advertised effort must not trigger probing or retries');
    assert.equal(requests[0].reasoning.effort, expected);
    assert.ok(!('thinkingEffort' in requests[0]) && !('reasoning_effort' in requests[0]));
  }
});

test('cancelled token exchange cannot resurrect a connection', async () => {
  let release;
  mockAuth();
  const flow = await auth.startCodexLogin();
  setModelFetcher(async url => url.endsWith('/deviceauth/token')
    ? Response.json({ authorization_code: 'code', code_verifier: 'verifier' })
    : new Promise(resolve => { release = () => resolve(Response.json(bundle())); }));
  const poll = auth.pollCodexLogin(flow.flowId);
  while (!release) await new Promise(resolve => setImmediate(resolve));
  auth.cancelCodexLogin(flow.flowId);
  release();
  await assert.rejects(poll);
  assert.equal(auth.codexStatus().connected, false);
});

test('parallel token refresh is single-flight and rotates persisted credentials', async () => {
  mockAuth();
  await connect();
  let refreshes = 0;
  setModelFetcher(async (_url, init) => {
    refreshes++;
    assert.equal(new URLSearchParams(init.body).get('refresh_token'), 'synthetic-refresh');
    await new Promise(resolve => setImmediate(resolve));
    return Response.json(bundle({ access_token: 'rotated-access', refresh_token: 'rotated-refresh' }));
  });
  const tokens = await Promise.all([auth.getCodexAuth({ force: true }), auth.getCodexAuth({ force: true })]);
  assert.equal(refreshes, 1);
  assert.ok(tokens.every(value => value.accessToken === 'rotated-access'));
});

test('encrypted storage restores a connection without plaintext secrets', async () => {
  const storage = { encrypt: text => Buffer.from(text).toString('base64'), decrypt: text => Buffer.from(text, 'base64').toString() };
  auth.setCodexStorage(storage);
  mockAuth();
  await connect();
  const disk = readFileSync(join(home, 'codex-auth.json'), 'utf8');
  assert.ok(!disk.includes('synthetic-access'));
  auth.setCodexStorage(storage);
  assert.equal(auth.codexStatus().connected, true);
  assert.equal(auth.codexStatus().models.length, 1);
});

test('persisted Codex catalogs refresh once, merge concurrent requests and preserve model selections', async () => {
  const storage = { encrypt: text => Buffer.from(text).toString('base64'), decrypt: text => Buffer.from(text, 'base64').toString() };
  auth.setCodexStorage(storage); mockAuth(); await connect();
  const connection = auth.resolveCodexModel('fixture-codex').codexConnectionId;
  auth.setCodexStorage(storage);
  let requests = 0;
  setModelFetcher(async () => {
    requests++; await new Promise(resolve => setImmediate(resolve));
    return Response.json({ models: [{ ...catalog.models[0], max_context_window: 1050000 }] });
  });
  await Promise.all([auth.refreshCodexCatalog(), auth.refreshCodexCatalog()]);
  await auth.refreshCodexCatalog();
  assert.equal(requests, 1);
  assert.equal(auth.codexModelCards()[0].context_size, 1050000);
  assert.equal(auth.codexStatus().models[0].model, 'fixture-codex');
  assert.equal(auth.resolveCodexModel('fixture-codex').codexConnectionId, connection);
});

test('a temporary catalog failure retains the cached connection and supports an explicit retry', async () => {
  const storage = { encrypt: text => Buffer.from(text).toString('base64'), decrypt: text => Buffer.from(text, 'base64').toString() };
  auth.setCodexStorage(storage); mockAuth(); await connect(); auth.setCodexStorage(storage);
  let requests = 0;
  setModelFetcher(async () => { requests++; throw Error('temporary fixture outage'); });
  await auth.refreshCodexCatalog(); await auth.refreshCodexCatalog();
  assert.equal(requests, 1);
  assert.equal(auth.codexStatus().connected, true);
  assert.equal(auth.codexModelCards()[0].context_size, 200000);
  setModelFetcher(async () => Response.json({ models: [{ ...catalog.models[0], max_context_window: 1000000 }] }));
  await auth.fetchCodexModels();
  assert.equal(auth.codexModelCards()[0].context_size, 1000000);
});

test('a disconnected account cannot be restored by a late catalog refresh', async () => {
  const storage = { encrypt: text => Buffer.from(text).toString('base64'), decrypt: text => Buffer.from(text, 'base64').toString() };
  auth.setCodexStorage(storage); mockAuth(); await connect(); auth.setCodexStorage(storage);
  let release, started;
  const requested = new Promise(resolve => { started = resolve; });
  setModelFetcher(() => new Promise(resolve => { release = () => resolve(Response.json(catalog)); started(); }));
  const refresh = auth.refreshCodexCatalog();
  await requested;
  auth.disconnectCodex(); release();
  await assert.rejects(refresh, { code: 'CODEX_REAUTH_REQUIRED' });
  assert.equal(auth.codexStatus().connected, false);
  assert.deepEqual(auth.codexModelCards(), []);
});

test('a resumed Codex run refreshes its budget before compacting history beyond the old window', { timeout: 15000 }, async () => {
  const { createSessionRecord, saveSessionRecord, loadSessionRecord } = await import('../src/asapi/store.js');
  const { startChatRun, subscribe } = await import('../src/asapi/bridge.js');
  const { estimateMessagesTokens } = await import('../src/context.js');
  const storage = { encrypt: text => Buffer.from(text).toString('base64'), decrypt: text => Buffer.from(text, 'base64').toString() };
  auth.setCodexStorage(storage); mockAuth(); await connect(); auth.setCodexStorage(storage);
  const history = 'x'.repeat(1200000);
  const record = createSessionRecord({ agent_id: 'context-fixture', chat_model_config: { type: auth.CODEX_PROVIDER, credential_id: auth.CODEX_CREDENTIAL_ID, model: 'fixture-codex', parameters: { contextSize: 128000 } }, cwd: home });
  record.config.naming = { auto: false };
  record.internal = [{ role: 'user', content: history }, { role: 'assistant', content: '已记住上下文' }];
  assert.ok(estimateMessagesTokens(record.internal) > 272000);
  saveSessionRecord(record);
  saveConfig({ hooksEnabled: false, injectProjectContext: false, changesAware: false, repoMapInject: false, checkpointEnabled: false, mcpServers: {}, review: { enabled: false } });
  let catalogs = 0, generations = 0;
  setModelFetcher(async (url, init) => {
    if (url.includes('/codex/models')) { catalogs++; return Response.json({ models: [{ ...catalog.models[0], max_context_window: 1050000 }] }); }
    assert.equal(url, auth.CODEX_BASE_URL + '/responses');
    generations++;
    const sent = JSON.parse(init.body);
    assert.ok(sent.input.some(item => item.role === 'user' && item.content?.some(part => part.text === history)), 'The original long history must reach the model intact');
    return stream([{ type: 'response.completed', response: { status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: '长上下文保留完成' }] }] } }]);
  });
  let finish;
  const done = new Promise(resolve => { finish = resolve; });
  const events = [];
  const unsubscribe = subscribe(record.id, frame => { events.push(frame.event); if (frame.event.type === 'REPLY_END') finish(frame.event); });
  try {
    assert.deepEqual(startChatRun(record.id, null, '继续检查上下文'), {});
    const end = await done;
    assert.equal(end.error, null, JSON.stringify(end.error));
    assert.equal(catalogs, 1);
    assert.equal(generations, 1, 'A sub-1M conversation must not trigger a separate compaction request');
    assert.ok(!JSON.stringify(events).includes('context_compacted'));
    assert.ok(loadSessionRecord(record.id).internal.some(message => message.role === 'user' && message.content === history));
    assert.equal(cfg().maxTokensBudget, 1050000 - 16384 - 8192);
  } finally { unsubscribe(); }
});

test('Responses adapter streams Unicode, tools, reasoning and usage with a fixed upstream', async () => {
  let sent;
  mockAuth((url, init) => {
    assert.equal(url, 'https://chatgpt.com/backend-api/codex/responses');
    assert.equal(init.headers.authorization, 'Bearer synthetic-access');
    assert.equal(init.headers['chatgpt-account-id'], 'workspace-fixture');
    sent = JSON.parse(init.body);
    return stream([
      { type: 'response.output_text.delta', delta: '你好🙂' },
      { type: 'response.reasoning_summary_text.delta', delta: '摘要' },
      { type: 'response.output_item.added', output_index: 1, item: { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'Read', arguments: '' } },
      { type: 'response.function_call_arguments.delta', output_index: 1, item_id: 'fc_1', delta: '{"path":' },
      { type: 'response.output_item.done', output_index: 1, item: { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'Read', arguments: '{"path":"a.txt"}' } },
      { type: 'response.completed', response: { status: 'completed', output: [{ type: 'reasoning', id: 'rs_1', encrypted_content: 'opaque', summary: [] }], usage: { input_tokens: 10, output_tokens: 5, input_tokens_details: { cached_tokens: 4 } } } },
    ]);
  });
  await connect();
  const deltas = [], thoughts = [];
  const result = await chatCompletion(createClient({ ...cfg(), temperature: 1, thinkingEffort: 'max' }), { messages: [{ role: 'system', content: 'Be useful' }, { role: 'user', content: [{ type: 'text', text: 'Read' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,AA==' } }] }], tools: [{ type: 'function', function: { name: 'Read', parameters: { type: 'object', properties: { path: { type: 'string' } } } } }], onDelta: value => deltas.push(value), onThinking: value => thoughts.push(value) });
  assert.equal(sent.stream, true);
  assert.equal(sent.store, false);
  assert.equal(sent.instructions, 'Be useful');
  assert.equal(sent.reasoning.effort, 'high');
  assert.equal(sent.tools[0].strict, false);
  for (const key of ['temperature', 'stream_options', 'max_output_tokens', 'top_p']) assert.ok(!(key in sent));
  assert.deepEqual(deltas, ['你好🙂']);
  assert.deepEqual(thoughts, ['摘要']);
  assert.equal(result.message.tool_calls.length, 1);
  assert.equal(result.message.tool_calls[0].function.arguments, '{"path":"a.txt"}');
  assert.equal(result.usage.cached_tokens, 4);
  assert.equal(result.message.tora_response_items[0].encrypted_content, 'opaque');
});

test('pending device polls are throttled and expire without further upstream requests', async t => {
  let time = Date.now(), polls = 0;
  t.mock.method(Date, 'now', () => time);
  mockAuth();
  const flow = await auth.startCodexLogin();
  setModelFetcher(async () => { polls++; return Response.json({}, { status: 403 }); });
  assert.equal((await auth.pollCodexLogin(flow.flowId)).status, 'pending');
  assert.equal((await auth.pollCodexLogin(flow.flowId)).status, 'pending');
  assert.equal(polls, 1);
  time += 901000;
  await assert.rejects(auth.pollCodexLogin(flow.flowId), { code: 'CODEX_LOGIN_EXPIRED' });
  assert.equal(polls, 1);
});

test('late refresh cannot overwrite a disconnected account', async () => {
  mockAuth(); await connect();
  let release;
  setModelFetcher(() => new Promise(resolve => { release = () => resolve(Response.json(bundle())); }));
  const refresh = auth.getCodexAuth({ force: true });
  auth.disconnectCodex(); release();
  await assert.rejects(refresh, { code: 'CODEX_REAUTH_REQUIRED' });
  assert.equal(auth.codexStatus().connected, false);
});

test('temporary refresh failure retains login, permanent invalid_grant requires login', async () => {
  mockAuth(); await connect();
  setModelFetcher(async () => { throw Error('synthetic-secret connection failure'); });
  await assert.rejects(auth.getCodexAuth({ force: true }), error => error.code === 'CODEX_NETWORK_ERROR' && !error.message.includes('synthetic-secret'));
  assert.equal(auth.codexStatus().connected, true);
  setModelFetcher(async () => Response.json({ error: 'invalid_grant' }, { status: 400 }));
  await assert.rejects(auth.getCodexAuth({ force: true }), { code: 'CODEX_REAUTH_REQUIRED' });
  assert.equal(auth.codexStatus().needsReauth, true);
  assert.deepEqual(auth.codexModelCards(), []);
});

test('a different user in the same ChatGPT workspace gets no old model selections', async () => {
  mockAuth(); await connect();
  const flow = await auth.startCodexLogin();
  setModelFetcher(async url => url.endsWith('/deviceauth/token')
    ? Response.json({ authorization_code: 'code', code_verifier: 'verifier' })
    : Response.json(bundle({ id_token: jwt({ sub: 'other-user', 'https://api.openai.com/auth': { chatgpt_account_id: 'workspace-fixture' } }) })));
  await auth.pollCodexLogin(flow.flowId);
  assert.deepEqual(auth.codexStatus().models, []);
});

test('only a pre-stream 401 refreshes and retries generation once', async () => {
  mockAuth(); await connect();
  let generations = 0, refreshes = 0;
  setModelFetcher(async (url, init) => {
    if (url.endsWith('/oauth/token')) { refreshes++; return Response.json(bundle({ access_token: 'new-token' })); }
    generations++;
    if (generations === 1) return Response.json({}, { status: 401 });
    assert.equal(init.headers.authorization, 'Bearer new-token');
    return stream([{ type: 'response.completed', response: { output: [{ type: 'message', content: [{ type: 'output_text', text: 'ok' }] }] } }]);
  });
  assert.equal((await chatCompletion(createClient(cfg()), { messages: [] })).message.content, 'ok');
  assert.equal(generations, 2); assert.equal(refreshes, 1);
});

test('quota failures and network failures never replay a generation request', async () => {
  mockAuth(); await connect();
  let attempts = 0;
  setModelFetcher(async () => { attempts++; return Response.json({}, { status: 429 }); });
  await assert.rejects(chatCompletion(createClient(cfg()), { messages: [] }), { code: 'CODEX_RATE_LIMIT' });
  assert.equal(attempts, 1);
  setModelFetcher(async () => { attempts++; throw Error('synthetic-secret'); });
  await assert.rejects(chatCompletion(createClient(cfg()), { messages: [] }), error => !error.message.includes('synthetic-secret'));
  assert.equal(attempts, 2);
});

test('tool history and opaque reasoning only replay to the same connection and model', async () => {
  mockAuth(); await connect();
  const { codexRequestBody } = await import('../src/codex.js');
  const client = createClient(cfg());
  const opaque = { type: 'reasoning', id: 'rs_1', encrypted_content: 'opaque', summary: [], tora_provider: auth.CODEX_PROVIDER, tora_connection_id: client.codexConnectionId, tora_model: client.model };
  const messages = [
    { role: 'assistant', content: '', tora_response_items: [opaque, { ...opaque, id: 'wrong', tora_connection_id: 'other' }], tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'Read', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'call_1', content: 'result' },
  ];
  const body = codexRequestBody(client, messages, []);
  assert.deepEqual(body.input.map(item => item.type), ['reasoning', 'function_call', 'function_call_output']);
  assert.equal(body.input[2].call_id, 'call_1');
  assert.equal(body.input[2].output, 'result');
  assert.ok(!JSON.stringify(body).includes('tora_connection_id'));
  assert.equal(codexRequestBody({ ...client, model: 'other-model' }, messages, []).input.filter(item => item.type === 'reasoning').length, 0);
});

test('cancellation is ABORTED and does not retry', async () => {
  mockAuth(); await connect();
  const controller = new AbortController(); let calls = 0;
  setModelFetcher(async () => { calls++; controller.abort(); throw controller.signal.reason; });
  await assert.rejects(chatCompletion(createClient(cfg()), { messages: [], signal: controller.signal }), { code: 'ABORTED' });
  assert.equal(calls, 1);
});

test('Agent completes a Codex tool-call round trip', async () => {
  const { runAgent } = await import('../src/agent.js');
  let requests = 0, executions = 0;
  mockAuth((_url, init) => {
    requests++;
    if (requests === 1) return stream([{ type: 'response.completed', response: { output: [{ type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'CodexFixture', arguments: '{"value":"hello"}' }] } }]);
    const body = JSON.parse(init.body);
    assert.ok(body.input.some(item => item.type === 'function_call_output' && item.call_id === 'call_1' && item.output.includes('hello')));
    return stream([{ type: 'response.completed', response: { output: [{ type: 'message', content: [{ type: 'output_text', text: '工具验证完成' }] }] } }]);
  });
  await connect();
  const messages = [{ role: 'user', content: 'Run CodexFixture' }], events = [];
  for await (const event of runAgent({ cfg: { ...cfg(), hooksEnabled: false, injectProjectContext: false, repoMapInject: false, changesAware: false, checkpointEnabled: false, mcpServers: {}, review: { enabled: false } }, cwd: home, messages, permissionMode: 'bypass', maxTurns: 3,
    extraTools: [{ name: 'CodexFixture', description: 'Test fixture', parameters: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'] }, execute: async args => { executions++; return { ok: true, result: args.value }; } }],
  })) events.push(event);
  assert.equal(executions, 1);
  assert.equal(requests, 2);
  assert.ok(!events.some(event => event.type === 'error'), JSON.stringify(events.filter(event => event.type === 'error')));
  assert.equal(messages.at(-1).content, '工具验证完成');
});

test('in-process ASAPI routes protect secrets, isolate cloud sync, and invalidate disabled selections', async t => {
  const { Server } = await import('node:http');
  const { Readable } = await import('node:stream');
  // Exercise the actual request listener without requiring an OS listening socket.
  t.mock.method(Server.prototype, 'listen', function (...args) { queueMicrotask(() => args.at(-1)()); return this; });
  const { startASAPIServer } = await import('../src/asapi/server.js');
  mockAuth();
  const server = await startASAPIServer({ port: 0 });
  const send = (path, method = 'GET', body, headers = {}) => new Promise(resolve => {
    const req = Readable.from(body ? [JSON.stringify(body)] : []);
    Object.assign(req, { url: path, method, headers: { host: '127.0.0.1', 'content-type': 'application/json', ...headers } });
    let status, responseHeaders;
    const res = { req, writeHead(code, values) { status = code; responseHeaders = values; }, end(text) { resolve(new Response(text, { status, headers: responseHeaders })); } };
    server.emit('request', req, res);
  });
  try {
    assert.equal((await send('/admin/codex/status', 'GET', null, { origin: 'https://evil.invalid' })).status, 403);
    assert.equal((await send('/admin/codex/status', 'GET', null, { host: 'evil.invalid' })).status, 403);
    assert.equal((await send('/admin/codex/device-flow/start', 'POST', {}, { 'content-type': 'text/plain' })).status, 415);
    const flow = await (await send('/admin/codex/device-flow/start', 'POST', {})).json();
    assert.equal((await send('/admin/codex/device-flow/poll', 'POST', { flowId: flow.flowId })).status, 200);
    assert.equal((await send('/admin/codex/models')).status, 200);
    assert.equal((await send('/admin/codex/models', 'PUT', { models: [{ model: 'fixture-codex', enabled: true }] })).status, 200);
    const credentials = await (await send('/credential/')).json();
    assert.ok(credentials.credentials.some(value => value.id === auth.CODEX_CREDENTIAL_ID));
    const cards = await (await send(`/model/?provider=${auth.CODEX_PROVIDER}`)).json();
    assert.equal(cards.models[0].name, 'fixture-codex');
    assert.equal((await send('/admin/models-config', 'PUT', { models: [] })).status, 200);
    assert.equal(auth.codexModelCards().length, 1);
    for (const path of ['/admin/codex/status', '/credential/', `/model/?provider=${auth.CODEX_PROVIDER}`, '/admin/config', '/admin/models-config']) {
      const text = await (await send(path)).text();
      assert.ok(!text.includes('synthetic-access') && !text.includes('synthetic-refresh'), path);
    }
    await send('/admin/codex/models', 'PUT', { models: [{ model: 'fixture-codex', enabled: false }] });
    assert.throws(cfg, /未启用/);
    assert.equal(auth.codexModelCards().length, 0);
    await send('/admin/reset', 'POST', {});
    assert.equal(auth.codexStatus().connected, false);
  } finally { server.removeAllListeners(); }
});

test('aborting one refresh waiter does not cancel another caller or duplicate rotation', async () => {
  mockAuth(); await connect();
  let release, requests = 0;
  setModelFetcher(() => { requests++; return new Promise(resolve => { release = () => resolve(Response.json(bundle({ access_token: 'shared-new-token' }))); }); });
  const controller = new AbortController();
  const first = auth.getCodexAuth({ force: true, signal: controller.signal });
  const second = auth.getCodexAuth({ force: true });
  controller.abort();
  await assert.rejects(first, { code: 'ABORTED' });
  const third = auth.getCodexAuth({ force: true });
  release();
  assert.equal((await second).accessToken, 'shared-new-token');
  assert.equal((await third).accessToken, 'shared-new-token');
  assert.equal(requests, 1);
});

test('function deltas accept output indexes and completed snapshots do not duplicate calls', async () => {
  mockAuth(() => stream([
    { type: 'response.output_item.added', output_index: 2, item: { type: 'function_call', id: 'fc_2', call_id: 'call_2', name: 'Read', arguments: '' } },
    { type: 'response.function_call_arguments.delta', output_index: 2, delta: '{}' },
    { type: 'response.completed', response: { output: [{ type: 'function_call', call_id: 'call_2', name: 'Read', arguments: '{}' }] } },
  ]));
  await connect();
  const result = await chatCompletion(createClient(cfg()), { messages: [] });
  assert.equal(result.message.tool_calls.length, 1);
  assert.equal(result.message.tool_calls[0].function.arguments, '{}');
});

test('invalid completed tool arguments and incomplete responses never execute', async () => {
  mockAuth(); await connect();
  for (const event of [
    { type: 'response.completed', response: { output: [{ type: 'function_call', call_id: 'call_1', name: 'Read', arguments: '{' }] } },
    { type: 'response.incomplete', response: { error: { message: 'private-oauth-value' } } },
  ]) {
    setModelFetcher(async () => stream([event]));
    await assert.rejects(chatCompletion(createClient(cfg()), { messages: [] }), error => error.code === 'CODEX_STREAM_ERROR' && !error.message.includes('private-oauth-value'));
  }
});

for (const contentType of ['text/event-stream', 'text/plain', 'application/json', '']) {
  test(`Codex streams before EOF with ${contentType || 'missing Content-Type'}`, async () => {
    let release, waiting;
    const blocked = new Promise(resolve => { waiting = resolve; });
    const encoder = new TextEncoder();
    mockAuth((_url, init) => {
      assert.equal(JSON.parse(init.body).stream, true);
      let reads = 0;
      return new Response(new ReadableStream({ pull(controller) {
        if (++reads === 1) controller.enqueue(encoder.encode(': connected\r\n\r\ndata: ' + JSON.stringify({ type: 'response.output_text.delta', delta: '正在输出🙂' }) + '\r\n\r\n'));
        else {
          release = () => { controller.enqueue(encoder.encode('data: ' + JSON.stringify({ type: 'response.completed', response: { status: 'completed', output: [] } }) + '\r\n\r\n')); controller.close(); };
          waiting();
        }
      } }, { highWaterMark: 0 }), { headers: contentType ? { 'content-type': contentType } : {} });
    });
    await connect();
    const deltas = [];
    const task = chatCompletion(createClient(cfg()), { messages: [{ role: 'user', content: 'hi' }], onDelta: text => deltas.push(text) });
    try {
      await Promise.race([blocked, task.then(() => { throw Error('Response ended before the stream was released'); })]);
      assert.deepEqual(deltas, ['正在输出🙂'], 'The first delta must arrive while the response body is still open');
      release(); release = null;
      assert.equal((await task).message.content, '正在输出🙂');
    } finally { release?.(); await task.catch(() => {}); }
  });
}

test('a completed JSON body is accepted when Codex does not stream', async () => {
  mockAuth(() => Response.json({ object: 'response', status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: '直接返回' }] }] }));
  await connect();
  const result = await chatCompletion(createClient(cfg()), { messages: [{ role: 'user', content: 'hi' }] });
  assert.equal(result.message.content, '直接返回');
});

test('JSON errors from Codex replace the generic stream failure without exposing secrets', async () => {
  mockAuth(() => Response.json({ error: { message: '模型暂时不可用 private-oauth-value' } }));
  await connect();
  await assert.rejects(chatCompletion(createClient(cfg()), { messages: [{ role: 'user', content: 'hi' }] }), error => error.code === 'CODEX_STREAM_ERROR' && error.message === 'Codex 未返回有效的流式响应');
  mockAuth(() => Response.json({ error: { message: '模型暂时不可用' } }));
  await connect();
  await assert.rejects(chatCompletion(createClient(cfg()), { messages: [{ role: 'user', content: 'hi' }] }), /模型暂时不可用/);
});

test('unterminated final SSE lines and background titles use the Codex route', async () => {
  const { generateTitle } = await import('../src/title.js');
  mockAuth((url, init) => {
    assert.equal(url, auth.CODEX_BASE_URL + '/responses');
    assert.equal(JSON.parse(init.body).reasoning.effort, 'low');
    return new Response('data: ' + JSON.stringify({ type: 'response.completed', response: { output: [{ type: 'message', content: [{ type: 'output_text', text: '检查配置' }] }] } }), { headers: { 'content-type': 'text/event-stream' } });
  });
  await connect();
  assert.equal(await generateTitle({ ...cfg(), baseURL: 'https://untrusted.invalid' }, { userText: '检查配置文件', language: 'zh' }), '检查配置');
});

test('truncated Responses streams never return executable partial tools', async () => {
  mockAuth(() => stream([{ type: 'response.output_item.done', item: { type: 'function_call', call_id: 'call_1', name: 'Bash', arguments: '{"command":"touch a"}' } }]));
  await connect();
  await assert.rejects(chatCompletion(createClient(cfg()), { messages: [{ role: 'user', content: 'hello' }] }), /中断|未完成/);
});
