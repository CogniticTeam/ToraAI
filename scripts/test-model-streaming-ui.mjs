import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright-core';

const home = mkdtempSync(join(tmpdir(), 'tora-streaming-ui-'));
process.env.TORA_HOME = home;
const { setModelFetcher } = await import('../packages/core/src/model-transport.js');
const { chatCompletion, createClient, thinkingParameterProperties } = await import('../packages/core/src/model.js');
const { resolveRunCfg } = await import('../packages/core/src/asapi/bridge.js');
const auth = await import('../packages/core/src/codex-auth.js');
const { startASAPIServer } = await import('../packages/core/src/asapi/server.js');
const cloudBase = 'https://stream-cloud.fixture.invalid';
const output = resolve(process.env.TORA_TEST_OUTPUT || 'output/streaming-qa');
const locale = JSON.parse(readFileSync(new URL('../packages/desktop/frontend/src/i18n/locales/zh.json', import.meta.url), 'utf8'));
const first = '第一段正在流式显示。', second = '第二段继续到达，流式验证完成。';
const encoder = new TextEncoder();
const packet = event => encoder.encode(`data: ${JSON.stringify(event)}\r\n\r\n`);
const completed = text => ({ type: 'response.completed', response: { status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text }] }], usage: { input_tokens: 10, output_tokens: 5 } } });
const jwt = value => `header.${Buffer.from(JSON.stringify(value)).toString('base64url')}.signature`;
const secretStorage = { encrypt: text => Buffer.from(text).toString('base64'), decrypt: text => Buffer.from(text, 'base64').toString() };
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const waitForSignal = async promise => {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(Error('Streaming fixture did not advance within 15 seconds')), 15000); })]); }
  finally { clearTimeout(timer); }
};
let pending = null, started = deferred(), cancelled = deferred(), jsonRequests = 0, catalogRequests = 0;
const openAIRequests = [];
const models = [
  { id: 'fixture-json', provider: 'custom', label: 'JSON fixture', model: 'fixture-json', baseURL: 'https://model.fixture.invalid/v1', apiKey: 'fixture-key', enabled: true },
  ...[
    ['openai', 'gpt-5.5', 'https://api.openai.com/v1'],
    ['openai', 'o3', 'https://api.openai.com/v1'],
    ['openai', 'gpt-5', 'https://api.openai.com/v1'],
    ['deepseek', 'deepseek-flash', 'https://api.deepseek.com/v1'],
    ['anthropic', 'claude-sonnet-4-5', 'https://api.anthropic.com/v1'],
  ].map(([provider, model, baseURL]) => ({ id: model, provider, label: provider, model, baseURL, apiKey: 'fixture-key', enabled: true })),
];
const efforts = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
const codexFixtures = [
  { slug: 'fixture-codex-stream', display_name: 'Codex stream fixture', context_window: 272000, supported_reasoning_levels: efforts.map(effort => ({ effort })) },
  { slug: 'fixture-codex-pair', context_window: 128000, supported_reasoning_levels: ['low', 'high'] },
  { slug: 'fixture-codex-single', context_window: 128000, supported_reasoning_levels: ['high'] },
  { slug: 'fixture-codex-undeclared', context_window: 128000 },
];
const cloudResponse = path => path === '/auth/me' ? { id: 'stream-fixture', username: 'stream-fixture' }
  : path === '/models' ? { models } : path === '/account/messages' ? { messages: [], unread: 0 }
  : path === '/account/events-ticket' ? { ticket: 'fixture-ticket' } : path === '/tochat/quota' ? { enabled: false, models: [] } : {};
const originalFetch = globalThis.fetch;
globalThis.fetch = (url, init) => String(url).startsWith(cloudBase) ? Promise.resolve(Response.json(cloudResponse(new URL(url).pathname))) : originalFetch(url, init);
setModelFetcher(async (url, init) => {
  if (url.endsWith('/usercode')) return Response.json({ device_auth_id: 'fixture-device', user_code: 'TEST-CODE', interval: 1 });
  if (url.endsWith('/deviceauth/token')) return Response.json({ authorization_code: 'fixture-code', code_verifier: 'fixture-verifier' });
  if (url.endsWith('/oauth/token')) return Response.json({ access_token: 'fixture-access', refresh_token: 'fixture-refresh', expires_in: 3600, id_token: jwt({ sub: 'fixture-user', 'https://api.openai.com/auth': { chatgpt_account_id: 'fixture-account' } }) });
  if (url.includes('/codex/models')) {
    catalogRequests++;
    return Response.json({ models: codexFixtures.map(model => model.slug === 'fixture-codex-stream' && catalogRequests > 1 ? { ...model, max_context_window: 1050000 } : model) });
  }
  if (url === 'https://model.fixture.invalid/v1/chat/completions') {
    assert.equal(JSON.parse(init.body).stream, true);
    jsonRequests++;
    return Response.json({ choices: [{ message: { role: 'assistant', content: '完整 JSON 回复也会显示。' } }], usage: { prompt_tokens: 2, completion_tokens: 3 } });
  }
  if (url === 'https://api.openai.com/v1/chat/completions') {
    openAIRequests.push(JSON.parse(init.body));
    return Response.json({ choices: [{ message: { role: 'assistant', content: 'Low reasoning fixture' } }] });
  }
  assert.equal(url, auth.CODEX_BASE_URL + '/responses');
  const body = JSON.parse(init.body);
  assert.equal(body.stream, true);
  if (!body.tools.length) return Response.json(completed('流式验证').response);
  return new Response(new ReadableStream({
    start(controller) { pending = controller; controller.enqueue(packet({ type: 'response.output_text.delta', delta: first })); started.resolve(); },
    cancel() { pending = null; cancelled.resolve(); },
  }), { headers: { 'content-type': 'application/json' } });
});
let server, browser, page;
try {
  auth.setCodexStorage(secretStorage);
  const flow = await auth.startCodexLogin();
  await auth.pollCodexLogin(flow.flowId);
  await auth.fetchCodexModels();
  auth.saveCodexModels(codexFixtures.map(model => ({ model: model.slug, enabled: true })));
  auth.setCodexStorage(secretStorage);
  server = await startASAPIServer({ port: Number(process.argv[2] || 0) });
  const base = `http://127.0.0.1:${server.address().port}`;
  console.log(`Streaming UI fixture ready at ${base}`);
  const executablePath = [process.env.TORA_CHROME_PATH, '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', '/usr/bin/chromium'].find(path => path && existsSync(path));
  assert.ok(executablePath, 'Set TORA_CHROME_PATH to a Chrome/Chromium binary');
  browser = await chromium.launch({ headless: true, executablePath, args: ['--no-sandbox'] });
  page = await browser.newPage({ viewport: { width: 1280, height: 800 }, locale: 'zh-CN' });
  page.setDefaultTimeout(15000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route(`${cloudBase}/**`, route => route.fulfill({
    status: route.request().method() === 'OPTIONS' ? 204 : 200, contentType: 'application/json',
    headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'authorization,content-type', 'access-control-allow-methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS' },
    ...(route.request().method() === 'OPTIONS' ? {} : { body: JSON.stringify(cloudResponse(new URL(route.request().url()).pathname)) }),
  }));
  await page.routeWebSocket('wss://stream-cloud.fixture.invalid/**', socket => {
    socket.send(JSON.stringify({ type: 'ready' }));
    socket.onMessage(value => { if (value === 'ping') socket.send('pong'); });
  });
  await page.addInitScript(({ base, cloudBase }) => {
    for (const [key, value] of Object.entries({ server_url: base, username: 'stream-fixture', tora_auth_token: 'fixture-token', tora_auth_api: cloudBase, tora_language_preference: 'zh', 'tora.theme': 'light', 'tora.background': 'none', 'tora:first-run:intro:v1': '1', 'tora:first-run:tour:v1': '1', 'tora:first-use-consent:v1': JSON.stringify({ terms: true, privacy: true, crossBorder: true }) })) if (localStorage.getItem(key) === null) localStorage.setItem(key, value);
  }, { base, cloudBase });
  await page.goto(base + '/chat?new=1', { waitUntil: 'domcontentloaded' });
  const input = page.locator('#tour-chat-textarea');
  const range = page.getByTestId('reasoning-effort-slider');
  const picker = page.getByTestId('model-picker');
  let modelWrites = 0, failNextWrite = false, holdNextWrite = null, failSessionReads = false;
  let failedRead = deferred();
  await page.route(`${base}/sessions/**`, async route => {
    const request = route.request();
    if (request.method() === 'GET' && new URL(request.url()).pathname === '/sessions/' && failSessionReads) {
      failedRead.resolve();
      return route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'fixture session read failed' }) });
    }
    if (request.method() === 'PATCH' && request.postDataJSON()?.chat_model_config) {
      modelWrites++;
      if (failNextWrite) {
        failNextWrite = false;
        return route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'fixture model write failed' }) });
      }
      if (holdNextWrite) {
        const held = holdNextWrite;
        holdNextWrite = null;
        held.entered.resolve();
        await held.release.promise;
      }
    }
    await route.continue();
  });
  const trigger = () => page.locator('#tour-llm-select, #tour-model-selector').first();
  const openPicker = async () => {
    await page.waitForFunction(() => {
      const button = document.querySelector('#tour-llm-select, #tour-model-selector');
      return button && !button.disabled;
    });
    if (await trigger().getAttribute('aria-expanded') !== 'true') await trigger().click();
    await picker.waitFor();
  };
  const selectModel = async name => {
    await openPicker();
    await picker.getByRole('button', { name, exact: true }).click();
    await page.waitForFunction(name => {
      const button = document.querySelector('#tour-llm-select, #tour-model-selector');
      return button?.textContent.includes(name) && !button.disabled;
    }, name);
    await openPicker();
  };
  const waitLevel = async level => page.waitForFunction(level => {
    const tick = document.querySelector(`[data-testid="reasoning-effort-tick"][data-effort="${level}"]`);
    return tick?.getAttribute('aria-pressed') === 'true' && !document.querySelector('[data-testid="reasoning-effort-slider"]')?.disabled;
  }, level);
  const chooseLevel = async level => {
    await page.locator(`[data-testid="reasoning-effort-tick"][data-effort="${level}"]`).click();
    await waitLevel(level);
  };
  const settledSlider = async () => page.waitForFunction(() => {
    const input = document.querySelector('[data-testid="reasoning-effort-slider"]');
    const track = document.querySelector('.reasoning-effort-track');
    const thumb = document.querySelector('.reasoning-effort-thumb');
    if (!input || !track || !thumb) return false;
    const target = 14 + (track.clientWidth - 28) * Number(input.value) / Math.max(1, Number(input.max));
    if (Math.abs(parseFloat(getComputedStyle(thumb).left) - target) > 0.25) return false;
    for (let element = track; element; element = element.parentElement) if (Number(getComputedStyle(element).opacity) < 0.999) return false;
    return true;
  });
  const dragTo = async (fraction, release = true) => {
    const box = await range.boundingBox();
    assert.ok(box);
    const current = Number(await range.inputValue()) / Math.max(1, Number(await range.getAttribute('max')));
    await page.mouse.move(box.x + 14 + (box.width - 28) * current, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + 14 + (box.width - 28) * fraction, box.y + box.height / 2, { steps: 18 });
    if (release) await page.mouse.up();
  };
  await selectModel('fixture-codex-stream');
  await input.waitFor();
  const capacity = locale['llm-select'].contextBadge.replace('{{size}}', '1.05M');
  await page.getByText(capacity, { exact: true }).waitFor();
  await page.waitForFunction(text => {
    const badge = [...document.querySelectorAll('span')].find(element => element.textContent === text);
    if (!badge) return false;
    for (let element = badge; element; element = element.parentElement) if (Number(getComputedStyle(element).opacity) < 0.99) return false;
    return true;
  }, capacity);
  assert.equal(catalogRequests, 2, 'A persisted small-window catalog must refresh automatically once');
  mkdirSync(output, { recursive: true });
  await page.screenshot({ path: join(output, 'context-capacity.png') });
  await page.keyboard.press('Escape');
  console.log('PASS: a persisted Codex catalog upgrades to its advertised 1.05M context in the real model picker');
  await openPicker();
  assert.deepEqual(await page.getByTestId('reasoning-effort-tick').evaluateAll(buttons => buttons.map(button => button.dataset.effort)), efforts);
  await chooseLevel('minimal');
  assert.ok((await trigger().innerText()).includes(locale['llm-select'].level.minimal));
  await range.focus();
  await page.keyboard.press('End');
  await waitLevel('max');
  await page.keyboard.press('Home');
  await waitLevel('none');
  assert.equal(await page.locator('.reasoning-effort-stars > span').count(), 0);
  await chooseLevel('max');
  assert.equal(await page.locator('.reasoning-effort-stars > span').count(), 22);
  assert.deepEqual(await page.evaluate(() => Object.fromEntries([
    ['track', '.reasoning-effort-track'], ['thumb', '.reasoning-effort-thumb'], ['button', '.reasoning-effort-labels > button'],
  ].map(([name, selector]) => [name, getComputedStyle(document.querySelector(selector)).borderTopLeftRadius]))), { track: '8px', thumb: '8px', button: '6px' });
  const beforeCancel = await trigger().innerText();
  await dragTo(2 / 6, false);
  assert.equal(await range.inputValue(), '2');
  assert.equal(await trigger().innerText(), beforeCancel, 'The collapsed trigger must not show an uncommitted drag');
  await page.keyboard.press('Escape');
  const box = await range.boundingBox();
  await page.mouse.move(box.x + 14, box.y + box.height / 2);
  await page.mouse.up();
  await waitLevel('max');
  assert.equal(await trigger().innerText(), beforeCancel, 'Escape must cancel the rest of the pointer gesture');
  assert.equal(modelWrites, 0, 'Draft effort edits must not PATCH a nonexistent session');
  await openPicker();
  await settledSlider();
  await page.screenshot({ path: join(output, 'reasoning-max-light.png') });

  for (const [name, values] of [
    ['fixture-codex-pair', ['low', 'high']],
    ['gpt-5.5', ['low', 'medium', 'high']],
    ['deepseek-flash', ['off', 'low', 'high', 'max']],
    ['claude-sonnet-4-5', ['off', 'on']],
  ]) {
    await selectModel(name);
    assert.deepEqual(await page.getByTestId('reasoning-effort-tick').evaluateAll(buttons => buttons.map(button => button.dataset.effort)), values);
  }
  await selectModel('fixture-codex-single');
  assert.equal(await page.getByTestId('reasoning-effort-tick').count(), 1);
  assert.equal(await range.isDisabled(), true);
  for (const name of ['fixture-codex-undeclared', 'fixture-json']) {
    await selectModel(name);
    await page.getByTestId('thinking-unavailable').waitFor();
    assert.equal(await range.count(), 0);
  }
  await selectModel('fixture-codex-stream');
  await chooseLevel('max');
  await page.evaluate(() => localStorage.setItem('tora.theme', 'dark'));
  await page.reload({ waitUntil: 'domcontentloaded' });
  await selectModel('fixture-codex-stream');
  await chooseLevel('max');
  assert.equal(await page.locator('html').evaluate(element => element.classList.contains('dark')), true);
  await settledSlider();
  await page.screenshot({ path: join(output, 'reasoning-max-dark.png') });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.waitForFunction(() => document.querySelector('[data-testid="reasoning-effort"]')?.dataset.motion === 'off');
  assert.equal(await page.locator('.reasoning-effort-stars > span').count(), 0);
  assert.equal(await page.locator('.reasoning-effort-sweep').evaluate(element => getComputedStyle(element).animationName), 'none');
  await page.setViewportSize({ width: 375, height: 812 });
  await page.waitForFunction(() => {
    const box = document.querySelector('[data-testid="model-picker"]')?.getBoundingClientRect();
    return box && box.left >= 0 && box.right <= innerWidth;
  });
  const menuBox = await picker.boundingBox();
  assert.ok(menuBox.x >= 0 && menuBox.x + menuBox.width <= 375, 'The picker must fit a narrow viewport');
  await range.scrollIntoViewIfNeeded();
  await settledSlider();
  await page.screenshot({ path: join(output, 'reasoning-mobile.png') });
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.evaluate(() => localStorage.setItem('tora.theme', 'light'));
  await page.reload({ waitUntil: 'domcontentloaded' });
  await selectModel('fixture-codex-stream');
  await chooseLevel('max');
  await page.keyboard.press('Escape');
  await input.waitFor();
  console.log('PASS: exact model capabilities, keyboard endpoints, cancelled drags, themes, reduced motion and narrow layouts');
  await input.fill('验证真正的增量回复');
  await input.press('Enter');
  await waitForSignal(started.promise);
  const reply = page.locator('[data-role="assistant"]').filter({ hasText: first }).last();
  await reply.waitFor();
  await page.waitForFunction(text => {
    const reply = [...document.querySelectorAll('[data-role="assistant"]')].find(element => element.textContent.includes(text));
    if (!reply) return false;
    for (let element = reply; element; element = element.parentElement) if (Number(getComputedStyle(element).opacity) < 0.99) return false;
    return true;
  }, first);
  assert.ok(pending, 'First delta must be displayed before the model stream is closed');
  assert.equal(await trigger().isDisabled(), true, 'Model edits must be locked during a run');
  assert.ok(!(await reply.innerText()).includes(second));
  mkdirSync(output, { recursive: true });
  await page.screenshot({ path: join(output, 'before-completion.png') });
  console.log('PASS: first Codex delta is visible while its mislabeled upstream stream remains open');
  pending.enqueue(packet({ type: 'response.output_text.delta', delta: second }));
  await page.locator('[data-role="assistant"]').filter({ hasText: second }).last().waitFor();
  assert.ok(pending, 'Second delta must also display before completion');
  const finish = pending; pending = null;
  finish.enqueue(packet(completed(first + second))); finish.close();
  const stop = page.getByRole('button', { name: locale.textInput.stop, exact: true });
  await stop.waitFor({ state: 'hidden' });
  assert.equal((await reply.innerText()).split(first).length - 1, 1, 'Completed snapshot must not duplicate streamed text');

  const codeLocation = page.url();
  const parts = new URL(codeLocation).pathname.split('/').filter(Boolean);
  const agentId = parts.at(-2), codeSessionId = parts.at(-1);
  const readSession = async id => (await originalFetch(`${base}/sessions/${id}?agent_id=${agentId}`)).json();
  let record = await readSession(codeSessionId);
  assert.equal(record.session.config.chat_model_config.parameters.thinkingEffort, 'max', 'The first send must include the draft effort');
  const modelConfig = record.session.config.chat_model_config;
  await originalFetch(`${base}/sessions/${codeSessionId}?agent_id=${agentId}`, {
    method: 'PATCH', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chat_model_config: { ...modelConfig, parameters: { ...modelConfig.parameters, temperature: 0.42 } } }),
  });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await openPicker();
  let writesBefore = modelWrites;
  const confirmed = await trigger().innerText();
  await dragTo(2 / 6, false);
  assert.equal(modelWrites, writesBefore, 'Pointer moves must not save before release');
  assert.equal(await trigger().innerText(), confirmed);
  await page.mouse.up();
  await waitLevel('low');
  assert.equal(modelWrites, writesBefore + 1, 'One drag must produce exactly one PATCH');
  record = await readSession(codeSessionId);
  assert.equal(record.session.config.chat_model_config.parameters.thinkingEffort, 'low');
  assert.equal(record.session.config.chat_model_config.parameters.temperature, 0.42);
  writesBefore = modelWrites;
  await chooseLevel('low');
  assert.equal(modelWrites, writesBefore, 'Selecting the confirmed value must not write again');
  await range.focus();
  await page.keyboard.down('ArrowRight');
  await page.keyboard.down('ArrowRight');
  assert.equal(modelWrites, writesBefore, 'Held-key changes must wait for keyup');
  await page.keyboard.up('ArrowRight');
  await waitLevel('high');
  assert.equal(modelWrites, writesBefore + 1);

  const held = { entered: deferred(), release: deferred() };
  holdNextWrite = held;
  writesBefore = modelWrites;
  await page.locator('[data-effort="max"]').evaluate(button => {
    button.click();
    document.querySelector('[data-effort="medium"]').click();
  });
  await waitForSignal(held.entered.promise);
  assert.equal(modelWrites, writesBefore + 1, 'Same-frame activations must share the synchronous write lock');
  assert.equal(await range.isDisabled(), true);
  assert.equal(await picker.getByRole('button', { name: 'fixture-codex-pair', exact: true }).isDisabled(), true);
  held.release.resolve();
  await waitLevel('max');
  writesBefore = modelWrites;
  failNextWrite = true;
  await page.locator('[data-effort="none"]').click();
  await waitLevel('max');
  assert.equal(modelWrites, writesBefore + 1);
  record = await readSession(codeSessionId);
  assert.equal(record.session.config.chat_model_config.parameters.thinkingEffort, 'max', 'A failed save must retain the confirmed effort');
  await chooseLevel('none');
  record = await readSession(codeSessionId);
  assert.equal(record.session.config.chat_model_config.parameters.thinking, false);
  assert.equal(record.session.config.chat_model_config.parameters.thinkingEffort, 'none');
  writesBefore = modelWrites;
  await chooseLevel('none');
  await range.press('Home');
  await waitLevel('none');
  assert.equal(modelWrites, writesBefore, 'An exact saved None remains confirmed and must not write again');
  await chooseLevel('minimal');
  await page.reload({ waitUntil: 'domcontentloaded' });
  await openPicker();
  await waitLevel('minimal');
  record = await readSession(codeSessionId);
  assert.equal(record.session.config.chat_model_config.parameters.temperature, 0.42);
  writesBefore = modelWrites;
  await dragTo(1, false);
  await page.goto(base + '/chat?new=1', { waitUntil: 'domcontentloaded' });
  await page.mouse.up();
  assert.equal(modelWrites, writesBefore, 'Navigation must discard an unfinished drag');
  await page.goto(codeLocation, { waitUntil: 'domcontentloaded' });
  await input.waitFor();
  console.log('PASS: one-write gestures, exact Minimal persistence, unchanged parameters, failed-save rollback and navigation cleanup');

  started = deferred(); cancelled = deferred();
  await input.fill('验证中途停止');
  await input.press('Enter');
  await waitForSignal(started.promise);
  await page.waitForFunction(text => [...document.querySelectorAll('[data-role="assistant"]')].filter(element => element.textContent.includes(text)).length === 2, first);
  await stop.click();
  await waitForSignal(cancelled.promise);
  await stop.waitFor({ state: 'hidden' });
  assert.equal(pending, null);
  console.log('PASS: Stop cancels and releases the open upstream reader');

  await page.getByRole('button', { name: locale.common['new-task'], exact: true }).click();
  await page.locator('#tour-llm-select').click();
  await page.getByRole('button', { name: 'fixture-json', exact: true }).click();
  await input.fill('验证一次性 JSON 兼容回复');
  await input.press('Enter');
  await page.locator('[data-role="assistant"]').filter({ hasText: '完整 JSON 回复也会显示。' }).last().waitFor();
  assert.ok(jsonRequests > 0);
  console.log('PASS: non-streaming JSON reaches the same real UI display pipeline');

  const completeLegacySession = async session => {
    const before = openAIRequests.length;
    await chatCompletion(createClient(resolveRunCfg(session)), { messages: [{ role: 'user', content: 'Legacy reasoning fixture' }] });
    assert.equal(openAIRequests.length, before + 1);
    return openAIRequests.at(-1);
  };
  for (const model of ['o3', 'gpt-5']) {
    for (const gesture of ['tick', 'home', 'pointer']) {
      const created = await originalFetch(base + '/sessions/', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ agent_id: agentId, model_source: 'custom', chat_model_config: {
          type: 'openai_compatible', credential_id: 'cocode-models', model, parameters: { thinking: false },
        } }),
      });
      assert.equal(created.status, 200);
      const id = (await created.json()).session_id;
      const legacy = (await readSession(id)).session;
      assert.deepEqual(legacy.config.chat_model_config.parameters, { thinking: false });
      assert.deepEqual(thinkingParameterProperties(resolveRunCfg(legacy)), {
        thinkingEffort: { type: 'string', enum: ['low', 'medium', 'high'], default: 'high' },
      });
      assert.equal(Object.hasOwn(await completeLegacySession(legacy), 'reasoning_effort'), false);
      await page.goto(`${base}/chat/${agentId}/${id}`, { waitUntil: 'domcontentloaded' });
      await openPicker();
      await waitLevel('low');
      writesBefore = modelWrites;
      if (gesture === 'home') {
        await range.focus();
        await page.keyboard.down('Home');
        await page.keyboard.press('Escape');
        await page.keyboard.up('Home');
        await waitLevel('low');
        assert.equal(modelWrites, writesBefore, 'Cancelling a legacy fallback must not normalize it');
        await openPicker();
        await range.focus();
        await page.keyboard.down('Home');
        await page.keyboard.down('Home');
        assert.equal(modelWrites, writesBefore, 'Home repeats must wait for keyup even at the first stop');
        await page.keyboard.up('Home');
      } else if (gesture === 'pointer') {
        await range.click({ position: { x: 14, y: 22 } });
      } else {
        await chooseLevel('low');
      }
      await waitLevel('low');
      assert.equal(modelWrites, writesBefore + 1, `${model}: ${gesture} must normalize legacy Off with exactly one PATCH`);
      if (gesture !== 'tick') await page.waitForFunction(() => document.activeElement === document.querySelector('[data-testid="reasoning-effort-slider"]'));
      const saved = (await readSession(id)).session;
      assert.deepEqual(saved.config.chat_model_config.parameters, { thinking: true, thinkingEffort: 'low', contextWindow: 'max' });
      const wire = await completeLegacySession(saved);
      assert.equal(wire.model, model);
      assert.equal(wire.reasoning_effort, 'low', `${model}: ${gesture} must send the requested Low effort`);
      if (model === 'o3' && gesture === 'home') {
        await settledSlider();
        await page.screenshot({ path: join(output, 'reasoning-legacy-low.png') });
      }
      await chooseLevel('low');
      await range.press('Home');
      await range.click({ position: { x: 14, y: 22 } });
      await waitLevel('low');
      assert.equal(modelWrites, writesBefore + 1, 'Confirmed Low tick, Home and pointer actions must not write again');
    }
  }
  console.log('PASS: legacy o3/gpt-5 Off normalizes once via Low tick, Home or pointer, retains focus/cancellation and sends reasoning_effort=low');

  writesBefore = modelWrites;
  await page.goto(`${base}/tochat/${agentId}?task=chat`, { waitUntil: 'domcontentloaded' });
  await selectModel('fixture-codex-stream');
  await chooseLevel('minimal');
  assert.equal(modelWrites, writesBefore, 'ToChat drafts must use the same local-only effort control');
  const created = await originalFetch(base + '/sessions/', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ agent_id: agentId, application_mode: 'tochat', task_mode: 'chat', model_source: 'custom', chat_model_config: { ...modelConfig, parameters: { ...modelConfig.parameters, thinkingEffort: 'minimal', thinking: true } } }),
  });
  assert.equal(created.status, 200);
  const tochatId = (await created.json()).session_id;
  const tochatLocation = `${base}/tochat/${agentId}/${tochatId}?task=chat`;
  await page.goto(tochatLocation, { waitUntil: 'domcontentloaded' });
  await openPicker();
  await waitLevel('minimal');
  failSessionReads = true;
  failedRead = deferred();
  await chooseLevel('high');
  await waitForSignal(failedRead.promise);
  assert.ok((await trigger().innerText()).includes(locale['llm-select'].level.high), 'A failed list refetch must not undo a confirmed PATCH');
  failSessionReads = false;
  record = await readSession(tochatId);
  assert.equal(record.session.config.chat_model_config.parameters.thinkingEffort, 'high');
  await page.reload({ waitUntil: 'domcontentloaded' });
  await openPicker();
  await waitLevel('high');
  await settledSlider();
  await page.screenshot({ path: join(output, 'reasoning-tochat.png') });
  await picker.getByRole('button', { name: locale['llm-select'].addCredential, exact: true }).click();
  await picker.waitFor({ state: 'hidden' });
  assert.equal(await trigger().getAttribute('aria-expanded'), 'false');
  await page.getByText('模型管理', { exact: true }).waitFor();
  assert.deepEqual(errors, []);
  console.log('PASS: ToChat draft/session persistence, confirmed-cache fallback and Add Model popover cleanup');
  console.log(`Streaming and reasoning UI regressions passed. Screenshots: ${output}`);
} catch (error) {
  console.error(error.stack || error);
  if (page) {
    mkdirSync(output, { recursive: true });
    await page.screenshot({ path: join(output, 'failure.png') }).catch(() => {});
    console.error((await page.locator('body').innerText().catch(() => '')).slice(-1800));
  }
  throw error;
} finally {
  if (process.argv.includes('--preview')) {
    console.log('UI test finished; preview remains available until stopped.');
    await new Promise(resolve => process.once('SIGTERM', resolve));
  }
  await browser?.close();
  if (server) { server.closeAllConnections?.(); await new Promise(resolve => server.close(resolve)); }
  auth.disconnectCodex(); setModelFetcher(null); globalThis.fetch = originalFetch;
  rmSync(home, { recursive: true, force: true });
}
