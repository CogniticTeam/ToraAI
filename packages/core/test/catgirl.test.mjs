import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { appendCatgirlPersona, CATGIRL_PERSONA_PROMPT } from '../src/catgirl.js';
import { nativeText, normalizeNativeLanguage } from '../../desktop/native-i18n.js';

function flatten(value, path = '', out = {}) {
  if (typeof value === 'string') out[path] = value;
  else if (value && typeof value === 'object') for (const [key, item] of Object.entries(value)) flatten(item, path ? `${path}.${key}` : key, out);
  return out;
}
const markers = (text, regex) => [...text.matchAll(regex)].map(([value]) => value).sort();

test('两套猫娘词库覆盖原词条，保留插值、标签、代码和语言名称', () => {
  for (const base of ['zh', 'ja']) {
    const locale = name => JSON.parse(readFileSync(new URL(`../../desktop/frontend/src/i18n/locales/${name}.json`, import.meta.url), 'utf8'));
    const source = flatten(locale(base)), target = flatten(locale(`${base}-Neko`));
    assert.deepEqual(Object.keys(target).sort(), Object.keys(source).sort());
    let changed = 0;
    for (const key of Object.keys(source)) {
      if (source[key] !== target[key]) changed++;
      for (const regex of [/\{\{[^{}]*\}\}/g, /<\/?[A-Za-z][^>]*>/g, /`[^`]*`/g, /https?:\/\/\S+/g]) {
        assert.deepEqual(markers(target[key], regex), markers(source[key], regex), key);
      }
    }
    assert.ok(changed > Object.keys(source).length * 0.7, '猫娘口吻覆盖大部分界面文案');
    assert.match(target['chat.inputPlaceholder'], base === 'zh' ? /本喵/ : /にゃ/);
    assert.equal(target['settings.general.language.ja'], source['settings.general.language.ja']);
    assert.equal(normalizeNativeLanguage(`${base}-Neko`), `${base}-Neko`);
    assert.match(nativeText(`${base}-Neko`, 'File'), base === 'zh' ? /喵/ : /にゃ/);
  }
});

test('后端解锁、开关持久化和引擎系统注入覆盖自定义智能体及 ToChat；关闭会清除历史注入', async () => {
  const home = mkdtempSync(join(tmpdir(), 'tora-catgirl-core-'));
  process.env.TORA_HOME = home;
  const { startASAPIServer } = await import('../src/asapi/server.js');
  const { loadConfig, saveConfig, CONFIG_PATH } = await import('../src/config.js');
  const { runAgent } = await import('../src/agent.js');
  const { resolveRunCfg } = await import('../src/asapi/bridge.js');
  const api = await startASAPIServer({ port: 0 });
  const requests = [];
  const model = createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    requests.push(JSON.parse(raw));
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: '测试回复喵' } }] }));
  });
  await new Promise(resolve => model.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${api.address().port}/admin/catgirl`;
  const post = patch => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(patch) });
  try {
    assert.deepEqual(await (await fetch(url)).json(), { installed: false, enabled: false });
    assert.equal((await post({ enabled: true })).status, 409);
    assert.equal((await post({ enabled: 'false' })).status, 422);
    assert.equal((await post({ install: 'false' })).status, 422);
    assert.deepEqual(await (await post({ install: true })).json(), { installed: true, enabled: false });
    assert.deepEqual(await (await post({ enabled: true })).json(), { installed: true, enabled: true });
    assert.equal(JSON.parse(readFileSync(CONFIG_PATH, 'utf8')).catgirlPersonaEnabled, true);
    saveConfig({ baseURL: `http://127.0.0.1:${model.address().port}/v1`, apiKey: 'fixture', model: 'fixture', hooksEnabled: false, injectProjectContext: false, thinking: false });
    const messages = [{ role: 'system', content: '旧提示词' }, { role: 'user', content: '你好' }];
    for (const mode of ['tocode', 'tochat']) {
      const cfg = resolveRunCfg({ config: { application_mode: mode, task_mode: 'chat', model_source: 'custom' } }, { data: { system_prompt: '自定义智能体：保持严肃语气' } });
      cfg.thinking = false;
      for await (const event of runAgent({ cfg, systemPrompt: '调用者自定义提示词', messages })) assert.notEqual(event.type, 'error', event.error);
      const system = requests.at(-1).messages.find(message => message.role === 'system').content;
      assert.ok(system.endsWith(CATGIRL_PERSONA_PROMPT));
      assert.equal(system.split('[Tora 猫娘人格 /').length - 1, 1);
      if (mode === 'tocode') assert.ok(system.includes('调用者自定义提示词'));
      else assert.ok(system.includes('You are ToChat'));
    }
    await post({ enabled: false });
    messages.push({ role: 'user', content: '继续' });
    for await (const event of runAgent({ cfg: loadConfig(), messages })) assert.notEqual(event.type, 'error', event.error);
    assert.ok(!requests.at(-1).messages[0].content.includes(CATGIRL_PERSONA_PROMPT));
    assert.equal(appendCatgirlPersona('base', { catgirlPersonaEnabled: true }), 'base');
    assert.deepEqual(await (await fetch(url)).json(), { installed: true, enabled: false });
    await post({ enabled: true });
    assert.equal((await post({ install: false, enabled: true })).status, 422);
    assert.deepEqual(await (await post({ install: false })).json(), { installed: false, enabled: false });
    const disabled = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
    assert.equal(disabled.catgirlLanguagePackInstalled, false);
    assert.equal(disabled.catgirlPersonaEnabled, false);
    assert.equal((await post({ enabled: true })).status, 409);
    for await (const event of runAgent({ cfg: loadConfig(), messages })) assert.notEqual(event.type, 'error', event.error);
    assert.ok(!requests.at(-1).messages[0].content.includes(CATGIRL_PERSONA_PROMPT));
    assert.deepEqual(await (await post({ install: true })).json(), { installed: true, enabled: false });
  } finally {
    api.closeAllConnections?.(); model.closeAllConnections?.();
    await Promise.all([new Promise(resolve => api.close(resolve)), new Promise(resolve => model.close(resolve))]);
    rmSync(home, { recursive: true, force: true });
  }
});
