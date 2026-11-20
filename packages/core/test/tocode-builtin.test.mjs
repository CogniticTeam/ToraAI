import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const home = mkdtempSync(join(tmpdir(), 'tora-desktop-models-'));
process.env.TORA_HOME = home;
const { saveConfig } = await import('../src/config.js');
const { startASAPIServer } = await import('../src/asapi/server.js');
const { resolveRunCfg } = await import('../src/asapi/bridge.js');
const server = await startASAPIServer({ port: 0 });
const base = 'http://127.0.0.1:' + server.address().port;

after(async () => {
  server.closeAllConnections?.();
  await new Promise(resolve => server.close(resolve));
  rmSync(home, { recursive: true, force: true });
});

test('Desktop omits the official credential and rejects direct access to retired model routes', async () => {
  saveConfig({
    modelList: [{ id:'own', model:'personal-model', baseURL:'https://personal.invalid/v1', apiKey:'personal-fixture', provider:'custom', enabled:true }],
  });
  const sync = await fetch(base + '/admin/tochat-config', { method:'POST' });
  assert.equal(sync.status, 410);
  const { credentials } = await (await fetch(base + '/credential/')).json();
  assert.ok(!credentials.some(credential => credential.id === 'tora-official'));
  const official = await (await fetch(base + '/model/?provider=tora_official')).json();
  assert.deepEqual(official.models, []);
  const custom = await (await fetch(base + '/model/?provider=openai_compatible')).json();
  assert.deepEqual(custom.models.map(card => card.name), ['personal-model']);
});

test('legacy official selections stop without fallback, while custom DeepSeek still works in ToChat', () => {
  for (const mode of ['tocode', 'tochat']) {
    assert.throws(() => resolveRunCfg({ config: {
      application_mode:mode, model_source:'official',
      chat_model_config:{ type:'tora_official', credential_id:'tora-official', model:'deepseek-flash' },
    }}), /官方模型已下线/);
  }
  const custom = { type:'openai_compatible', model:'personal-model' };
  assert.equal(resolveRunCfg({config:{application_mode:'tocode',chat_model_config:custom}}).model, 'personal-model');
  assert.throws(() => resolveRunCfg({config:{
    application_mode:'tochat', model_source:'custom', chat_model_config:custom,
  }}), /仅支持 DeepSeek/);
  const configured = resolveRunCfg({config:{
    application_mode:'tochat', model_source:'custom', chat_model_config:{...custom,model:'deepseek-ai/DeepSeek-V3'},
  }});
  assert.equal(configured.model,'deepseek-ai/DeepSeek-V3');
  assert.notEqual(configured.provider, 'tochat-official');
});
