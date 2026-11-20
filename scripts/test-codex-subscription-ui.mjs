// Real frontend + isolated ASAPI; OAuth and cloud services are fixtures, never real accounts.
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright-core';

const home = mkdtempSync(join(tmpdir(), 'tora-codex-ui-'));
process.env.TORA_HOME = home;
const { startASAPIServer } = await import('../packages/core/src/asapi/server.js');
const { setModelFetcher } = await import('../packages/core/src/model-transport.js');
const { codexStatus } = await import('../packages/core/src/codex-auth.js');
const output = resolve(process.env.TORA_TEST_OUTPUT || 'output/codex-qa');
const jwt = value => `header.${Buffer.from(JSON.stringify(value)).toString('base64url')}.signature`;
let authorized = false, failCatalog = true, polls = 0;
const cloudModels = [{ id: 'cloud-fixture', provider: 'custom', label: 'Fixture API', model: 'fixture-codex', baseURL: 'https://model.fixture.invalid/v1', apiKey: 'synthetic-api-key', enabled: true }];
function cloudResponse(path) {
  if (path === '/auth/me') return { id: 'codex-ui', username: 'codex-ui' };
  if (path === '/models') return { models: cloudModels };
  if (path === '/plans') return { plans: [] };
  if (path === '/tochat/quota') return { enabled: false, models: [] };
  if (path === '/account/messages') return { messages: [], unread: 0 };
  if (path === '/account/events-ticket') return { ticket: 'fixture' };
  return {};
}
const realFetch = globalThis.fetch;
globalThis.fetch = (url, init) => String(url).startsWith('https://api.cogniticteam.com/') ? Promise.resolve(Response.json(cloudResponse(new URL(url).pathname))) : realFetch(url, init);
setModelFetcher(async url => {
  if (url.endsWith('/usercode')) return Response.json({ device_auth_id: 'private-device', user_code: 'TEST-CODE', interval: 1, expires_in: 900 });
  if (url.endsWith('/deviceauth/token')) { polls++; return authorized ? Response.json({ authorization_code: 'code', code_verifier: 'verifier' }) : Response.json({}, { status: 403 }); }
  if (url.endsWith('/oauth/token')) return Response.json({ access_token: 'private-oauth-access', refresh_token: 'private-oauth-refresh', expires_in: 3600, id_token: jwt({ email: 'fixture@example.com', sub: 'fixture-user', 'https://api.openai.com/auth': { chatgpt_account_id: 'fixture-account' } }) });
  if (url.includes('/codex/models')) return failCatalog ? Response.json({}, { status: 503 }) : Response.json({ models: [{ slug: 'fixture-codex', display_name: 'Fixture Codex', context_window: 200000, input_modalities: ['text', 'image'], supported_reasoning_levels: [{ effort: 'low' }, { effort: 'high' }] }] });
  throw Error(`Unexpected model request: ${url}`);
});
let server, browser;
try {
  server = await startASAPIServer({ port: 0 });
  const base = `http://127.0.0.1:${server.address().port}`;
  const executablePath = [process.env.TORA_CHROME_PATH, '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', '/usr/bin/chromium'].find(path => path && existsSync(path));
  assert.ok(executablePath, 'Set TORA_CHROME_PATH to a Chrome/Chromium binary');
  browser = await chromium.launch({ headless: true, executablePath, args: ['--no-sandbox'] });
  const page = await browser.newPage({ viewport: { width: 1160, height: 860 }, locale: 'zh-CN' });
  const errors = [], cloudRequests = [], mirrors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => { if (request.url().includes('/admin/models-config') && request.method() === 'PUT') mirrors.push(request.postData()); });
  await page.route('https://api.cogniticteam.com/**', route => {
    cloudRequests.push(route.request().postData() || '');
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(cloudResponse(new URL(route.request().url()).pathname)) });
  });
  await page.routeWebSocket('wss://api.cogniticteam.com/**', socket => socket.onMessage(value => { if (value === 'ping') socket.send('pong'); }));
  await page.addInitScript(() => { Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async () => {} } }); });
  await page.goto(base, { waitUntil: 'commit' });
  await page.evaluate(serverUrl => {
    for (const [key, value] of Object.entries({ server_url: serverUrl, username: 'codex-ui', tora_auth_token: 'fixture-token', tora_language_preference: 'zh', 'tora:first-run:intro:v1': '1', 'tora:first-run:tour:v1': '1', 'tora:first-use-consent:v1': JSON.stringify({ terms: true, privacy: true, crossBorder: true }) })) localStorage.setItem(key, value);
  }, base);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.locator('#tour-llm-select').waitFor();
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('tora:open-settings', { detail: 'model' })));
  await page.getByRole('button', { name: '添加模型', exact: true }).click();
  const entry = page.getByTestId('add-codex-subscription');
  await entry.waitFor();
  assert.ok((await entry.innerText()).includes('使用你订阅的Codex套餐'));
  mkdirSync(output, { recursive: true });
  await page.screenshot({ path: join(output, 'add-model-light.png') });
  await entry.click();
  const panel = page.getByTestId('codex-subscription');
  assert.equal(await panel.locator('input[type=password]').count(), 0);
  await panel.getByRole('button', { name: '使用 ChatGPT 登录' }).click();
  await page.getByTestId('codex-user-code').waitFor();
  assert.equal(await panel.getByRole('link', { name: '打开授权页面' }).getAttribute('href'), 'https://auth.openai.com/codex/device');
  await panel.getByRole('button', { name: '复制验证码' }).click();
  await panel.getByRole('button', { name: '已复制' }).waitFor();
  await page.screenshot({ path: join(output, 'authorization-light.png') });
  await Promise.all([page.waitForResponse(response => response.url().endsWith('/device-flow/cancel')), panel.getByRole('button', { name: '取消', exact: true }).click()]);
  const before = polls;
  await page.waitForTimeout(1300);
  assert.equal(polls, before, 'Cancelled login must stop polling');
  authorized = true;
  await panel.getByRole('button', { name: '使用 ChatGPT 登录' }).click();
  await panel.getByText('已连接', { exact: true }).waitFor();
  await panel.getByRole('alert').waitFor();
  failCatalog = false;
  await panel.getByRole('button', { name: '重试', exact: true }).click();
  await panel.getByRole('checkbox').check();
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.setViewportSize({ width: 800, height: 860 });
  await page.screenshot({ path: join(output, 'models-dark.png') });
  await panel.getByRole('button', { name: '保存', exact: true }).click();
  const row = page.locator('[data-model-source="codex"]');
  await row.waitFor();
  assert.equal(await page.locator('[data-model-source="cloud"]').count(), 1);
  await row.getByRole('switch').click();
  await page.waitForFunction(async base => !(await (await fetch(base + '/admin/codex/status')).json()).models[0].enabled, base);
  await row.getByRole('switch').click();
  await page.waitForFunction(async base => (await (await fetch(base + '/admin/codex/status')).json()).models[0].enabled, base);
  assert.ok(mirrors.every(body => !body.includes('codex_subscription')));
  assert.ok(cloudRequests.every(body => !/private-oauth|private-device|code_verifier/.test(body)));
  await row.getByRole('button', { name: '删除', exact: true }).click();
  await row.waitFor({ state: 'hidden' });
  await page.getByRole('button', { name: '添加模型', exact: true }).click();
  await page.getByTestId('add-codex-subscription').click();
  await panel.getByRole('button', { name: '断开 Codex 连接', exact: true }).click();
  await page.getByRole('dialog', { name: '断开 Codex 连接', exact: true }).getByRole('button', { name: '断开 Codex 连接', exact: true }).click();
  await panel.getByRole('button', { name: '使用 ChatGPT 登录' }).waitFor();
  assert.equal(codexStatus().connected, false);
  assert.deepEqual(errors, []);
  console.log('Codex UI: login/cancel, catalog retry, add/toggle/remove/disconnect and cloud isolation passed.');
  console.log(`Screenshots: ${output}`);
} finally {
  await browser?.close();
  if (server) { server.closeAllConnections?.(); await new Promise(resolve => server.close(resolve)); }
  globalThis.fetch = realFetch; setModelFetcher(null);
  rmSync(home, { recursive: true, force: true });
}
