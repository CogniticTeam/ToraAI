// 独立 TORA_HOME + 假账号：验证累计 Token 弹窗，不写用户真实用量。
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright-core';

const chrome = [process.env.TORA_CHROME_PATH, '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome']
	.find((candidate) => candidate && existsSync(candidate));
if (!chrome) throw new Error('找不到 Chrome/Chromium');

const testHome = mkdtempSync(join(tmpdir(), 'tora-token-milestone-ui-'));
process.env.TORA_HOME = testHome;
const { startASAPIServer } = await import('../packages/core/src/asapi/server.js');
const { recordUsage, usageMilestoneStatus } = await import('../packages/core/src/asapi/usage-store.js');
const server = await startASAPIServer({ port: 0 });
const base = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ headless: true, executablePath: chrome, args: ['--no-sandbox'] });

try {
	const agentId = (await (await fetch(`${base}/agent/`)).json()).agents[0].id;
	const { session_id: sessionId } = await (await fetch(`${base}/sessions/`, {
		method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ agent_id: agentId }),
	})).json();
	usageMilestoneStatus(); // 初始化既有用量基线（这里是零）
	recordUsage({ tokens: 100_000 });

	const page = await browser.newPage({ viewport: { width: 1200, height: 760 }, locale: 'zh-CN' });
	const errors = [];
	page.on('pageerror', (error) => errors.push(error.message));
	await page.addInitScript((serverUrl) => {
		window.toraWindow = {
			isMaximized: () => false, onMaximizeChange: () => {}, getSystemLocale: () => 'zh-CN',
			reportLanguage: () => {}, reportTheme: () => {}, getRequiredUpdate: () => null,
			onRequiredUpdate: () => () => {}, refreshAccount: async () => {},
			openFolderDialog: async () => null, onMenuCommand: () => () => {}, getAppVersion: () => '1.0.0',
		};
		localStorage.setItem('server_url', serverUrl);
		localStorage.setItem('tora_auth_token', 'milestone-test-token');
		localStorage.setItem('username', 'milestone-test');
		localStorage.setItem('tora:first-run:intro:v1', '1');
		localStorage.setItem('tora:first-run:tour:v1', '1');
		localStorage.setItem('tora:first-use-consent:v1', JSON.stringify({ terms: true, privacy: true, crossBorder: true }));
	}, base);
	await page.route('https://tora.ohfun.online/auth/me', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ id: 'milestone-test', username: 'milestone-test' }) }));
	await page.route('https://tora.ohfun.online/tochat/quota', route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ enabled: false, models: [], chatRemaining: 150, workDailyRemaining: 1000000, workWeeklyRemaining: 10000000 }) }));
await page.route('https://tora.ohfun.online/models', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ models: [] }) }));
	await page.route('https://tora.ohfun.online/polls/config', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ enabled: false, entryVisible: false }) }));
	await page.route('https://tora.ohfun.online/account/messages', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ messages: [], unread: 0 }) }));
	await page.route('https://tora.ohfun.online/account/events-ticket', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ticket: 'milestone-test' }) }));
	await page.routeWebSocket('wss://tora.ohfun.online/account/events*', (socket) => { socket.onMessage((message) => { if (message === 'ping') socket.send('pong'); }); });

	await page.goto(`${base}/chat/${agentId}/${sessionId}`, { waitUntil: 'domcontentloaded' });
	const dialog = page.getByRole('dialog', { name: 'Token 里程碑达成' });
	await dialog.waitFor({ state: 'visible' });
	await dialog.getByText('10万', { exact: true }).waitFor({ state: 'visible' });
	await page.screenshot({ path: '/tmp/tora-token-milestone-ui.png' });
	await page.setViewportSize({ width: 390, height: 760 });
	assert.equal(await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth), true, '窄窗口弹窗不能横向溢出');
	await page.screenshot({ path: '/tmp/tora-token-milestone-mobile.png' });
	await page.setViewportSize({ width: 1200, height: 760 });
	await dialog.getByRole('button', { name: '继续使用 Tora' }).click();
	await dialog.waitFor({ state: 'hidden' });
	assert.deepEqual(usageMilestoneStatus().pending, []);
	await page.reload({ waitUntil: 'domcontentloaded' });
	assert.equal(await dialog.count(), 0, '确认过的 10万 档刷新后不得重弹');

	recordUsage({ tokens: 9_999_900_000 });
	await page.evaluate(() => window.dispatchEvent(new Event('focus')));
	await dialog.getByText('100万', { exact: true }).waitFor({ state: 'visible' });
	await dialog.getByRole('button', { name: '继续使用 Tora' }).click();
	await dialog.getByText('1000万', { exact: true }).waitFor({ state: 'visible' });
	assert.deepEqual(errors, []);
	console.log('Token 里程碑 UI：10万弹窗、确认去重、跨档依次展示均通过');
} finally {
	await browser.close();
	server.closeAllConnections?.();
	await Promise.race([new Promise((resolve) => server.close(resolve)), new Promise((resolve) => setTimeout(resolve, 1000))]);
	rmSync(testHome, { recursive: true, force: true });
}
