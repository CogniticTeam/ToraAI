import { test, beforeEach, afterEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Server } from 'node:http';
import { Readable } from 'node:stream';

// Set the data directory before importing anything that resolves TORA_DIR.
const home = mkdtempSync(join(tmpdir(), 'tora-reasoning-capabilities-'));
const environment = new Map(['TORA_HOME', 'TORA_BASE_URL', 'TORA_API_KEY', 'TORA_MODEL', 'OPENAI_BASE_URL', 'OPENAI_API_KEY']
  .map(key => [key, process.env[key]]));
for (const key of environment.keys()) delete process.env[key];
process.env.TORA_HOME = home;
const { thinkingParameterProperties, createClient, chatCompletion } = await import('../src/model.js');
const { anthropicThinkingParameters } = await import('../src/anthropic.js');
const { setModelFetcher } = await import('../src/model-transport.js');
const { CODEX_PROVIDER } = await import('../src/codex-protocol.js');
const { DEFAULT_CONFIG, saveConfig } = await import('../src/config.js');
const { resolveRunCfg } = await import('../src/asapi/bridge.js');
const { createCredential, createSessionRecord, loadSessionRecord } = await import('../src/asapi/store.js');
const { startASAPIServer } = await import('../src/asapi/server.js');
const { stopScheduler } = await import('../src/asapi/schedules.js');

const genericURL = 'https://reasoning.fixture.invalid/v1';
const openaiURL = 'https://api.openai.com/v1';
const anthropicURL = 'https://api.anthropic.com/v1';
const deepseekURL = 'https://api.deepseek.com/v1';
const googleURL = 'https://generativelanguage.googleapis.com/v1beta/openai';
const boolean = { type: 'boolean', default: true };
const effort = { type: 'string', enum: ['low', 'medium', 'high'], default: 'high' };
const schemas = {
  adaptive: { thinking: boolean, thinkingEffort: effort },
  always: { thinkingEffort: effort },
  budget: { thinking: boolean },
  deepseek: { thinking: boolean, thinkingEffort: { type: 'string', enum: ['low', 'high', 'max'], default: 'high' } },
  effort: { thinkingEffort: effort },
  'tool-none': { thinkingEffort: { type: 'string', enum: ['none'], default: 'none' } },
};
const tools = [{ type: 'function', function: { name: 'ReasoningFixture', parameters: { type: 'object', properties: {} } } }];
const messages = [{ role: 'user', content: 'Return the fixture response.' }];
let unexpectedRequests = 0;
function denyNetwork() {
  unexpectedRequests++;
  throw Error('Unexpected upstream request in reasoning test');
}
beforeEach(t => {
  unexpectedRequests = 0;
  t.mock.method(globalThis, 'fetch', denyNetwork);
  setModelFetcher(denyNetwork);
  saveConfig({ ...DEFAULT_CONFIG, provider: 'custom', baseURL: genericURL, apiKey: 'synthetic-global-secret', model: 'fixture-unknown', models: [], modelList: [] });
});
afterEach(() => {
  stopScheduler();
  setModelFetcher(null);
  assert.equal(unexpectedRequests, 0, 'Metadata must not probe upstream capabilities or use real network transport');
});
after(() => {
  rmSync(home, { recursive: true, force: true });
  for (const [key, value] of environment) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

const route = (name, cfg, kind) => ({ name, cfg: { provider: 'custom', baseURL: genericURL, apiKey: 'synthetic-model-secret', ...cfg }, kind });
const routes = [
  ...['claude-opus-4-6', 'claude-sonnet-4-6', 'claude-opus-5', 'claude-sonnet-5'].map(model =>
    route(`native Anthropic ${model}`, { provider: 'anthropic', model }, 'adaptive')),
  route('Anthropic official URL without native provider', { baseURL: anthropicURL + '/', model: 'claude-sonnet-4-6' }, 'adaptive'),
  ...['claude-opus-5-5', 'claude-opus-5-5-20261001', 'claude-fable-5', 'claude-mythos-5'].map(model =>
    route(`always-thinking Anthropic ${model}`, { provider: 'anthropic', model }, 'always')),
  ...['claude-3-7-sonnet-latest', 'claude-opus-4-1', 'claude-sonnet-4-5', 'claude-haiku-4-5'].map(model =>
    route(`budget Anthropic ${model}`, { provider: 'anthropic', model }, 'budget')),
  ...['https://api.deepseek.com', deepseekURL + '/'].map(baseURL =>
    route(`native DeepSeek at ${baseURL}`, { baseURL, model: 'deepseek-flash' }, 'deepseek')),
  route('existing official DeepSeek route', { provider: 'tochat-official', model: 'deepseek-flash' }, 'deepseek'),
  ...['gpt-5', 'gpt-6-astra', 'o1', 'o3-mini', 'o4-mini'].map(model =>
    route(`OpenAI API ${model}`, { baseURL: openaiURL, model }, 'effort')),
  route('APIYI provider route', { provider: 'apiyi', model: 'gpt-5' }, 'effort'),
  ...['api', 'b', 'vip', 'api-cf'].map(host =>
    route(`APIYI ${host} endpoint route`, { baseURL: `https://${host}.apiyi.com/v1`, model: 'o3' }, 'effort')),
  route('Shuliuyun provider route', { provider: 'shuliuyun', model: 'gpt-5' }, 'effort'),
  route('Shuliuyun endpoint route', { baseURL: 'https://shuliuyun.com/v1/', model: 'o3' }, 'effort'),
  route('existing official GPT route', { provider: 'tochat-official', model: 'gpt-6.1-sol' }, 'effort'),
  ...[
    { baseURL: openaiURL, model: 'gpt-6-sol' },
    { provider: 'apiyi', model: 'gpt-6-luna' },
    { provider: 'shuliuyun', model: 'gpt-6-sol-20261001' },
  ].map(cfg => route(`tool-restricted ${cfg.model} via ${cfg.provider || 'OpenAI'}`, cfg, 'tool-none')),
  ...['gemini-2.5-pro', 'gemini-3.8-flash'].map(model =>
    route(`Google API ${model}`, { baseURL: googleURL, model }, 'effort')),
  route('Shuliuyun Gemini route', { provider: 'shuliuyun', model: 'gemini-3.8-flash' }, 'effort'),
  route('Shuliuyun Gemini endpoint route', { baseURL: 'https://shuliuyun.com/v1', model: 'gemini-2.5-flash' }, 'effort'),
  route('existing official Gemini route', { provider: 'tochat-official', model: 'gemini-3.8-flash' }, 'effort'),
];

function expectedWire(kind, level = 'high', on = true) {
  if (kind === 'adaptive' || kind === 'always') return {
    thinking: { type: on ? 'adaptive' : 'disabled' }, output_config: { effort: on ? level : 'low' },
  };
  if (kind === 'budget') return on ? { thinking: { type: 'enabled', budget_tokens: 2048 } } : {};
  if (kind === 'deepseek') return { thinking: { type: on ? 'enabled' : 'disabled' }, reasoning_effort: on ? level : 'none' };
  return { reasoning_effort: level };
}
function reasoningFields(body) {
  return Object.fromEntries(['thinking', 'thinkingEffort', 'output_config', 'enable_thinking', 'reasoning_effort']
    .filter(key => Object.hasOwn(body, key)).map(key => [key, body[key]]));
}
async function captureCompletion(cfg, native = false) {
  const requests = [];
  setModelFetcher(async (url, init) => {
    requests.push({ url, init, body: JSON.parse(init.body) });
    return Response.json(native
      ? { content: [{ type: 'text', text: 'fixture response' }] }
      : { choices: [{ message: { role: 'assistant', content: 'fixture response' } }] });
  });
  const result = await chatCompletion(createClient(cfg), { messages, tools });
  assert.equal(result.message.content, 'fixture response');
  assert.equal(requests.length, 1, 'A valid advertised choice must work without a capability probe or retry');
  const request = requests[0];
  assert.equal(request.url, cfg.baseURL.replace(/\/+$/, '') + (native ? '/messages' : '/chat/completions'));
  assert.equal(request.init.method, 'POST');
  assert.equal(request.body.model, cfg.model);
  assert.equal(request.body.stream, true);
  return request.body;
}

for (const { name, cfg, kind } of routes) {
  test(`advertised choices produce their native wire fields: ${name}`, async () => {
    const properties = thinkingParameterProperties(cfg);
    assert.deepEqual(properties, schemas[kind]);
    const native = ['adaptive', 'always', 'budget'].includes(kind);
    if (native) assert.deepEqual(anthropicThinkingParameters(cfg.model), schemas[kind]);
    for (const level of properties.thinkingEffort?.enum || [undefined]) {
      const body = await captureCompletion({ ...cfg, thinking: true, ...(level ? { thinkingEffort: level } : {}) }, native);
      assert.deepEqual(reasoningFields(body), expectedWire(kind, level), `${name}: ${level || 'On'}`);
      if (properties.thinking) {
        const off = await captureCompletion({ ...cfg, thinking: false, thinkingEffort: level }, native);
        assert.deepEqual(reasoningFields(off), expectedWire(kind, level, false), `${name}: Off must override ${level || 'On'}`);
      }
    }
    const defaults = await captureCompletion(cfg, native);
    assert.deepEqual(reasoningFields(defaults), expectedWire(kind, properties.thinkingEffort?.default), `${name}: omitted parameters use the advertised defaults`);
  });
}

const unsupported = [
  ...['gpt-5', 'deepseek-flash', 'claude-sonnet-4-6', 'gemini-3.8-flash'].map(model => ({ model })),
  { provider: 'openai', model: 'gpt-5' },
  { provider: 'google', model: 'gemini-3.8-flash' },
  { provider: 'deepseek', model: 'deepseek-flash' },
  ...['claude-unknown', 'claude-3-5-sonnet-latest', 'claude-haiku-5-5'].map(model => ({ provider: 'anthropic', model })),
  { baseURL: anthropicURL, model: 'unknown-native' },
  ...['deepseek-chat', 'deepseek-reasoner', 'deepseek-future', 'deepseek-flash-preview', 'vendor/deepseek-flash'].map(model => ({ baseURL: deepseekURL, model })),
  ...[{ baseURL: openaiURL }, { provider: 'apiyi' }, { provider: 'shuliuyun' }].flatMap(cfg =>
    ['o1-mini', 'o1-preview', 'gpt-5-pro', 'o3-pro'].map(model => ({ ...cfg, model }))),
  ...['gpt-4o', 'gpt-4.1', 'unknown-native'].map(model => ({ baseURL: openaiURL, model })),
  ...['gemini-2.0-flash', 'gemini-2.4-pro', 'unknown-native'].map(model => ({ baseURL: googleURL, model })),
  { provider: 'apiyi', model: 'gemini-3.8-flash' },
  { provider: 'tochat-official', model: 'deepseek-future' },
  { provider: 'tochat-official', model: 'gemini-2.5-pro' },
  { baseURL: 'https://api.openai.com.evil.invalid/v1', model: 'gpt-5' },
  { baseURL: 'https://api.deepseek.com.evil.invalid/v1', model: 'deepseek-flash' },
  { baseURL: 'https://api.anthropic.com/v1/relay', model: 'claude-sonnet-4-6' },
  ...[openaiURL, anthropicURL, deepseekURL].map(baseURL => ({ provider: CODEX_PROVIDER, baseURL, model: 'gpt-5' })),
];
test('unsupported models, generic endpoints and the Codex type never invent capabilities', async t => {
  for (const cfg of unsupported) {
    const effective = { provider: 'custom', baseURL: genericURL, ...cfg };
    await t.test(`${effective.provider} ${effective.model} at ${effective.baseURL}`, () => {
      assert.deepEqual(thinkingParameterProperties(effective), {});
    });
  }
});
test('unsupported native Anthropic models do not acquire thinking wire fields', async () => {
  for (const model of ['claude-unknown', 'claude-haiku-5-5']) {
    assert.deepEqual(anthropicThinkingParameters(model), {});
    const body = await captureCompletion({ provider: 'anthropic', baseURL: genericURL, apiKey: 'synthetic-key', model, thinking: true }, true);
    assert.deepEqual(reasoningFields(body), {});
  }
});

// Invoke the real HTTP request listener in process; no development server or socket is needed.
async function modelAPI(t) {
  t.mock.method(Server.prototype, 'listen', function (...args) {
    queueMicrotask(() => args.at(-1)());
    return this;
  });
  const server = await startASAPIServer({ port: 0 });
  t.after(() => { stopScheduler(); server.removeAllListeners(); });
  return (path, method = 'GET', body) => new Promise(resolve => {
    const req = Readable.from(body === undefined ? [] : [JSON.stringify(body)]);
    Object.assign(req, { url: path, method, headers: { host: '127.0.0.1', 'content-type': 'application/json' } });
    let status, headers;
    const res = { req, writeHead(code, values) { status = code; headers = values; }, end(text) { resolve(new Response(text, { status, headers })); } };
    server.emit('request', req, res);
  });
}
async function readJSON(send, path, method, body) {
  const response = await send(path, method, body);
  const data = await response.json();
  assert.equal(response.status, 200, `${path}: ${JSON.stringify(data)}`);
  return data;
}
function assertCards(data, names, kinds, secrets = []) {
  assert.equal(data.total, names.length);
  assert.deepEqual(data.models.map(card => card.name), names, 'Capability calculation must not add, remove or reorder catalog members');
  for (const card of data.models) {
    assert.equal(card.parameter_schema.type, 'object');
    const { temperature, ...properties } = card.parameter_schema.properties;
    assert.equal(temperature.type, 'number');
    assert.deepEqual(properties, schemas[kinds[card.name]] || {}, card.name);
  }
  const serialized = JSON.stringify(data);
  for (const secret of ['synthetic-global-secret', ...secrets]) assert.ok(!serialized.includes(secret), 'Model metadata must not leak API keys');
  assert.doesNotMatch(serialized, /"(?:api_key|apiKey|access_token|refresh_token)":/);
}

test('cocode-models cards use each enabled model provider and endpoint, not the global route', async t => {
  const selected = [
    { model: 'gpt-5', provider: 'custom', baseURL: openaiURL, kind: 'effort' },
    { model: 'claude-sonnet-4-6', provider: 'anthropic', baseURL: genericURL, kind: 'adaptive' },
    { model: 'claude-opus-5-5', provider: 'custom', baseURL: anthropicURL, kind: 'always' },
    { model: 'deepseek-flash', provider: 'custom', baseURL: deepseekURL, kind: 'deepseek' },
    { model: 'gemini-3.8-flash', provider: 'shuliuyun', baseURL: genericURL, kind: 'effort' },
    { model: 'gpt-6-sol', provider: 'custom', baseURL: genericURL },
  ];
  const modelList = selected.map(({ kind, ...cfg }, index) => ({ ...cfg, enabled: true, apiKey: `synthetic-list-secret-${index}` }));
  saveConfig({ provider: 'anthropic', baseURL: anthropicURL, model: 'claude-opus-5', modelList: [...modelList,
    { provider: 'anthropic', model: 'claude-sonnet-5', baseURL: anthropicURL, enabled: false },
    { provider: 'custom', model: 'official-fixture', baseURL: genericURL, isOfficial: true, enabled: true },
    { provider: 'custom', model: 'retired-fixture', baseURL: 'https://retired.fixture.invalid/official/v1', enabled: true },
  ] });
  const send = await modelAPI(t), names = selected.map(value => value.model);
  const kinds = Object.fromEntries(selected.map(value => [value.model, value.kind]));
  for (const path of ['/model/', '/model/?provider=openai_compatible&credential_id=cocode-models', '/model/?provider=openai_compatible&credential_id=missing-credential']) {
    assertCards(await readJSON(send, path), names, kinds, modelList.map(value => value.apiKey));
  }
  for (const selectedModel of selected) {
    const run = resolveRunCfg({ config: { model_source: 'custom', chat_model_config: { credential_id: 'cocode-models', model: selectedModel.model } } });
    assert.equal(run.provider, selectedModel.provider);
    assert.equal(run.baseURL, selectedModel.baseURL);
    assert.deepEqual(thinkingParameterProperties(run), schemas[selectedModel.kind] || {});
  }
});

for (const enabledList of [false, true]) {
  test(`manual credential endpoints determine capabilities without changing membership (${enabledList ? 'enabled modelList' : 'fallback names'})`, async t => {
    const names = ['gpt-5', 'deepseek-flash', 'claude-sonnet-4-6', 'gemini-3.8-flash', 'gpt-6-sol', 'unknown-native'];
    // Deliberately conflicting modelList providers must not override cfg.provider for a manual credential.
    saveConfig({ model: names[0], models: [...names, ''], modelList: enabledList
      ? names.map(model => ({ model, provider: 'anthropic', baseURL: genericURL, apiKey: 'synthetic-list-secret', enabled: true })) : [] });
    const send = await modelAPI(t);
    const endpointCases = [
      [openaiURL, { 'gpt-5': 'effort', 'gpt-6-sol': 'tool-none' }],
      [deepseekURL, { 'deepseek-flash': 'deepseek' }],
      [anthropicURL, { 'claude-sonnet-4-6': 'adaptive' }],
      [googleURL, { 'gemini-3.8-flash': 'effort' }],
      [genericURL, {}],
    ];
    for (const [baseURL, kinds] of endpointCases) {
      const credential = createCredential({ type: 'openai_compatible', provider: 'anthropic', name: 'Fixture', base_url: baseURL, api_key: 'synthetic-credential-secret' });
      const data = await readJSON(send, `/model/?provider=openai_compatible&credential_id=${credential.id}`);
      assertCards(data, names, kinds, ['synthetic-credential-secret', 'synthetic-list-secret']);
      for (const model of names) {
        const run = resolveRunCfg({ config: { model_source: 'custom', chat_model_config: { credential_id: credential.id, model } } });
        assert.equal(run.provider, 'custom', 'Manual credentials leave cfg.provider unchanged');
        assert.equal(run.baseURL, baseURL);
        assert.deepEqual(thinkingParameterProperties(run), schemas[kinds[model]] || {});
      }
    }
  });
}

test('manual credentials preserve native cfg.provider and saved Off/effort parameters reach completion', async t => {
  const model = 'claude-sonnet-4-6';
  saveConfig({ provider: 'anthropic', model, models: [model], baseURL: anthropicURL,
    modelList: [{ model, provider: 'custom', baseURL: openaiURL, apiKey: 'synthetic-list-secret', enabled: true }] });
  const credential = createCredential({ type: 'openai_compatible', name: 'Native relay', base_url: genericURL, api_key: 'synthetic-credential-secret' });
  const send = await modelAPI(t);
  const record = createSessionRecord({ agent_id: 'reasoning-fixture', chat_model_config: { type: 'openai_compatible', credential_id: credential.id, model, parameters: {} }, cwd: home });
  for (const parameters of [{ thinking: true, thinkingEffort: 'low' }, { thinking: true, thinkingEffort: 'medium' }, { thinking: false, thinkingEffort: 'high' }, {}]) {
    await readJSON(send, `/sessions/${record.id}`, 'PATCH', { chat_model_config: { ...record.config.chat_model_config, parameters } });
    const restored = loadSessionRecord(record.id);
    assert.deepEqual(restored.config.chat_model_config.parameters, parameters);
    const run = resolveRunCfg(restored);
    assert.equal(run.provider, 'anthropic');
    assert.equal(run.baseURL, genericURL);
    assert.equal(run.apiKey, 'synthetic-credential-secret');
    const body = await captureCompletion(run, true);
    assert.deepEqual(reasoningFields(body), expectedWire('adaptive', parameters.thinkingEffort, parameters.thinking !== false));
  }
  setModelFetcher(denyNetwork);
  const data = await readJSON(send, `/model/?provider=openai_compatible&credential_id=${credential.id}`);
  assertCards(data, [model], { [model]: 'adaptive' }, ['synthetic-credential-secret', 'synthetic-list-secret']);
});
