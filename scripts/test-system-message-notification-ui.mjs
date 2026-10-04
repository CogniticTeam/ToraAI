// 隔离本地前端与模拟账户 WebSocket，不发送真实消息，也不触发系统通知。
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright-core';

const chrome = [process.env.TORA_CHROME_PATH, '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome'].find(path => path && existsSync(path));
if (!chrome) throw new Error('找不到 Chrome/Chromium');
const testHome = mkdtempSync(join(tmpdir(), 'tora-system-message-test-'));
process.env.TORA_HOME = testHome;
const { startASAPIServer } = await import('../packages/core/src/asapi/server.js');
const server = await startASAPIServer({ port: 0 });
const base = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ headless: true, executablePath: chrome, args: ['--no-sandbox'] });

try {
  const page = await browser.newPage({ locale: 'zh-CN', viewport: { width: 1280, height: 800 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => {
    window.__nativeMessageCalls = 0;
    window.__nativeTestCalls = 0;
    window.toraWindow = {
      isMaximized: () => false, onMaximizeChange: () => {}, getSystemLocale: () => 'zh-CN',
      reportLanguage: () => {}, reportTheme: () => {}, getRequiredUpdate: () => null,
      onRequiredUpdate: () => () => {}, refreshAccount: async () => {},
      openFolderDialog: async () => null, onMenuCommand: () => () => {}, getAppVersion: () => '1.0.0',
      notifyNewMessage: async () => { window.__nativeMessageCalls++; return { status: 'shown' }; },
      testMessageNotification: async () => { window.__nativeTestCalls++; return { status: 'shown' }; },
      onOpenMessagesFromNotification: cb => { window.__openMessagesFromNotification = cb; return () => { window.__openMessagesFromNotification = null; }; },
    };
  });
  await page.route('https://tora.ohfun.online/auth/me', route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ id: 1, username: 'notice-test', banned: false }) }));
  await page.route('https://tora.ohfun.online/tochat/quota', route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ enabled: false, models: [], chatRemaining: 150, remainingPercent: 100, canUseAgent: true, subscription: {planId:'plus',name:'Tora Plus',expiresAt:'2099-01-01T00:00:00Z'}, windows: [{key:'fiveHour',remainingPercent:100,resetAt:null}], workDailyRemaining: 1000000, workWeeklyRemaining: 10000000 }) }));
await page.route('https://tora.ohfun.online/models', route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ models: [] }) }));
  await page.route('https://tora.ohfun.online/polls/config', route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ enabled: true, entryVisible: true }) }));
  await page.route('https://tora.ohfun.online/account/messages', route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ messages: [], unread: 0 }) }));
  await page.route('https://tora.ohfun.online/account/events-ticket', route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ticket: 'notice-ticket' }) }));
  let resolveSocket;
  const socketReady = new Promise(resolve => { resolveSocket = resolve; });
  await page.routeWebSocket('wss://tora.ohfun.online/account/events*', socket => { resolveSocket(socket); socket.onMessage(message => { if (message === 'ping') socket.send('pong'); }); });
  await page.goto(base + '/', { waitUntil: 'domcontentloaded' });
  await page.evaluate(serverUrl => {
    localStorage.setItem('server_url', serverUrl);
    localStorage.setItem('tora_auth_token', 'notice-test-token');
    localStorage.setItem('username', 'notice-test');
    localStorage.setItem('tora:first-run:intro:v1', '1');
    localStorage.setItem('tora:first-run:tour:v1', '1');
    localStorage.setItem('tora:first-use-consent:v1', JSON.stringify({ terms: true, privacy: true, crossBorder: true }));
  }, base);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.locator('#tour-llm-select').first().waitFor({ state: 'visible' });
  const socket = await Promise.race([socketReady, new Promise((_, reject) => setTimeout(() => reject(new Error('WebSocket 未连接')), 5000))]);

  async function openSettings() {
    await page.getByRole('button', { name: /notice-test/i }).first().click();
    await page.getByRole('menuitem', { name: '设置' }).click();
    await page.getByText('系统消息通知', { exact: true }).waitFor({ state: 'visible' });
    return page.getByText('系统消息通知', { exact: true }).locator('xpath=../..').getByRole('switch');
  }
  let toggle = await openSettings();
  await page.waitForTimeout(350);
  await page.screenshot({ path: '/tmp/tora-system-message-settings.png' });
  assert.equal(await toggle.isChecked(), true, '系统消息通知默认开启');
  await page.getByRole('button', { name: '测试通知' }).click();
  await page.getByText(/系统已接收通知/).waitFor({ state: 'visible' });
  assert.equal(await page.evaluate(() => window.__nativeTestCalls), 1, '测试按钮只请求本地通知，不发送账户消息');
  await toggle.click();
  assert.equal(await page.evaluate(() => localStorage.getItem('tora:system-message-notifications:v1')), '0');
  await page.getByText('返回 Tora').click();
  socket.send(JSON.stringify({ type: 'message-received' }));
  await page.getByText('收到一条 Tora 消息').waitFor({ state: 'visible' });
  assert.equal(await page.evaluate(() => window.__nativeMessageCalls), 0, '关闭开关后不得请求原生通知');

  toggle = await openSettings();
  await toggle.click();
  assert.equal(await page.evaluate(() => localStorage.getItem('tora:system-message-notifications:v1')), '1');
  await page.getByText('返回 Tora').click();
  socket.send(JSON.stringify({ type: 'message-received' }));
  await page.waitForFunction(() => window.__nativeMessageCalls === 1);
  socket.send(JSON.stringify({ type: 'messages-changed' }));
  await page.waitForTimeout(100);
  assert.equal(await page.evaluate(() => window.__nativeMessageCalls), 1, '编辑或撤回事件不得当作新消息通知');
  await page.evaluate(() => window.__openMessagesFromNotification());
  await page.getByRole('dialog', { name: '消息' }).waitFor({ state: 'visible' });
  assert.deepEqual(errors, []);
  console.log('系统消息开关、仅新消息触发、点击通知打开消息窗口：通过');
} finally {
  await browser.close();
  server.closeAllConnections?.();
  await Promise.race([new Promise(resolve => server.close(resolve)), new Promise(resolve => setTimeout(resolve, 1000))]);
  rmSync(testHome, { recursive: true, force: true });
}
