// 回归：从模型选择框打开“模型管理”时，原选择框必须收起。
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright-core');
const chrome = [
  process.env.COCODE_CHROME_PATH,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
].find((path) => path && existsSync(path));
if (!chrome) throw new Error('找不到 Chrome/Chromium；可通过 COCODE_CHROME_PATH 指定');

const testHome = mkdtempSync(join(tmpdir(), 'cocode-model-picker-'));
process.env.COCODE_HOME = testHome;
const { startASAPIServer } = await import('../packages/core/src/asapi/server.js');
const server = await startASAPIServer({ port: 0 });
const base = `http://127.0.0.1:${server.address().port}`;
let browser;

try {
  browser = await chromium.launch({ headless: true, executablePath: chrome, args: ['--no-sandbox', '--disable-gpu'] });
  const page = await browser.newPage({ locale: 'zh-CN' });
  await page.route('https://cocode.ohfun.online/auth/me', (route) => route.fulfill({
    status: 200, contentType: 'application/json', body: JSON.stringify({ id: 'test', username: 'test' }),
  }));
  await page.route('https://cocode.ohfun.online/models', (route) => route.fulfill({
    status: 200, contentType: 'application/json', body: JSON.stringify({ models: [] }),
  }));
  await page.route('https://cocode.ohfun.online/account/messages', (route) => route.fulfill({
    status: 200, contentType: 'application/json', body: JSON.stringify({ messages: [], unread: 0, nextOffset: null }),
  }));
  await page.route('https://cocode.ohfun.online/account/events-ticket', (route) => route.fulfill({
    status: 200, contentType: 'application/json', body: JSON.stringify({ ticket: 'test-ticket' }),
  }));
  await page.routeWebSocket('wss://cocode.ohfun.online/account/events*', (socket) => {
    socket.send(JSON.stringify({ type: 'ready' }));
    socket.onMessage((message) => { if (message === 'ping') socket.send('pong'); });
  });
  await page.goto(base + '/', { waitUntil: 'commit', timeout: 10000 });
  await page.evaluate((serverUrl) => {
    localStorage.setItem('server_url', serverUrl);
    localStorage.setItem('username', 'test');
    localStorage.setItem('cocode_auth_token', 'test-token');
    localStorage.setItem('cocode_auth_api', 'https://cocode.ohfun.online');
  }, base);
  await page.reload({ waitUntil: 'networkidle', timeout: 15000 });

  const trigger = page.locator('#tour-llm-select');
  try {
    await trigger.click({ timeout: 15000 });
  } catch (error) {
    throw new Error(`${error.message}\n页面内容：${(await page.locator('body').innerText()).slice(0, 1000)}`);
  }
  const picker = page.locator('[data-slot="popover-content"]').filter({ hasText: '添加模型' }).last();
  await picker.waitFor({ state: 'visible', timeout: 5000 });
  await picker.getByRole('button', { name: '添加模型' }).click();
  await page.getByText('模型管理', { exact: true }).waitFor({ state: 'visible', timeout: 10000 });
  await picker.waitFor({ state: 'hidden', timeout: 5000 });
  assert.equal(await trigger.getAttribute('aria-expanded'), 'false');
  await page.getByRole('button', { name: '添加模型' }).click();
  for (const provider of ['Google Gemini', 'Anthropic', '阶跃星辰（中国）', '阶跃星辰（国际）']) {
    await page.getByText(provider, { exact: true }).waitFor({ state: 'visible', timeout: 5000 });
  }
  console.log('模型选择框已收起；Google、Anthropic、阶跃星辰中/国际版入口可见');
} finally {
  await browser?.close();
  server.closeAllConnections?.();
  await new Promise((resolve) => server.close(resolve));
  rmSync(testHome, { recursive: true, force: true });
}
