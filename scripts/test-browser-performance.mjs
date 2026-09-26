// 独立临时 ASAPI：验证浏览器面板静止时不再逐帧改写 WebView 宿主样式。
import { createRequire } from 'node:module';
import { strict as assert } from 'node:assert';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright-core');
const chrome = [process.env.COCODE_CHROME_PATH, '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', '/usr/bin/chromium'].find(candidate => candidate && existsSync(candidate));
if (!chrome) throw new Error('找不到 Chrome/Chromium，请设置 COCODE_CHROME_PATH');

const testHome = mkdtempSync(join(tmpdir(), 'cocode-browser-performance-'));
process.env.COCODE_HOME = testHome;
const { startASAPIServer } = await import('../packages/core/src/asapi/server.js');
const server = await startASAPIServer({ port: 0 });
const base = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ headless: true, executablePath: chrome, args: ['--no-sandbox'] });

try {
	const page = await browser.newPage({ viewport: { width: 1360, height: 850 }, locale: 'zh-CN' });
	const errors = [];
	page.on('pageerror', error => errors.push(error.message));
	await page.addInitScript(() => {
		window.cocodeWindow = {
			isMaximized: () => false, onMaximizeChange: () => {}, getSystemLocale: () => 'zh-CN',
			reportLanguage: () => {}, reportTheme: () => {}, getRequiredUpdate: () => null,
			onRequiredUpdate: () => () => {}, refreshAccount: async () => {},
			openFolderDialog: async () => null, onMenuCommand: () => () => {}, getAppVersion: () => '1.0.0',
		};
	});
	await page.goto(base + '/', { waitUntil: 'commit' });
	await page.route('https://cocode.ohfun.online/auth/me', route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ id: 'browser-performance-test', username: 'browser-performance-test' }) }));
	await page.route('https://cocode.ohfun.online/models', route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ models: [] }) }));
	await page.route('https://cocode.ohfun.online/polls/config', route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ enabled: true, entryVisible: true }) }));
	await page.route('https://cocode.ohfun.online/account/messages', route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ messages: [], unread: 0 }) }));
	await page.route('https://cocode.ohfun.online/account/events-ticket', route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ticket: 'browser-performance-ticket' }) }));
	await page.routeWebSocket('wss://cocode.ohfun.online/account/events*', socket => { socket.onMessage(message => { if (message === 'ping') socket.send('pong'); }); });
	await page.route('https://www.baidu.com/**', route => route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><title>Browser test</title><body>Browser test page</body>' }));
	await page.evaluate(serverUrl => {
		localStorage.setItem('server_url', serverUrl);
		localStorage.setItem('cocode_auth_token', 'browser-performance-token');
		localStorage.setItem('username', 'browser-performance-test');
		localStorage.setItem('cocode:first-run:intro:v1', '1');
		localStorage.setItem('cocode:first-run:tour:v1', '1');
	}, base);
	await page.reload({ waitUntil: 'domcontentloaded' });
	await page.locator('#tour-browser-nav').click();
	await page.waitForURL(/\/browser$/);
	const host = page.locator('[data-browser-host="true"]');
	await host.waitFor({ state: 'visible' });
	await page.frameLocator('[data-browser-host="true"] iframe').getByText('Browser test page').waitFor({ state: 'visible' });
	await page.waitForFunction(() => {
		const host = document.querySelector('[data-browser-host="true"]');
		const placeholder = document.querySelector('[data-browser-placeholder="true"]');
		if (!host || !placeholder) return false;
		const a = host.getBoundingClientRect();
		const b = placeholder.getBoundingClientRect();
		return Math.abs(a.left - b.left - 1) < 2 && Math.abs(a.top - b.top - 1) < 2;
	});
	await page.waitForTimeout(600); // 路由的 220ms 过渡和 450ms 跟踪窗口均已结束。
	const idleWrites = await host.evaluate(element => new Promise(resolve => {
		let writes = 0;
		const observer = new MutationObserver(events => { writes += events.length; });
		observer.observe(element, { attributes: true, attributeFilter: ['style'] });
		setTimeout(() => { observer.disconnect(); resolve(writes); }, 450);
	}));
	assert.ok(idleWrites <= 2, `浏览器静止时不应逐帧改写宿主样式，实际 ${idleWrites} 次`);
	await page.setViewportSize({ width: 1200, height: 760 });
	await page.waitForFunction(() => {
		const host = document.querySelector('[data-browser-host="true"]');
		const placeholder = document.querySelector('[data-browser-placeholder="true"]');
		if (!host || !placeholder) return false;
		const a = host.getBoundingClientRect();
		const b = placeholder.getBoundingClientRect();
		return Math.abs(a.left - b.left - 1) < 2 && Math.abs(a.width - b.width + 2) < 2;
	});
	await page.getByRole('button', { name: /新任务/ }).first().click();
	await page.waitForURL(/\/chat(?:\/|$)/);
	await page.waitForFunction(() => document.querySelector('[data-browser-host="true"]')?.style.visibility === 'hidden');
	await page.locator('button:has(svg.lucide-panel-right)').first().click();
	await page.getByRole('menuitemcheckbox', { name: /浏览器|Browser/ }).click();
	await page.keyboard.press('Escape');
	await page.waitForFunction(() => document.querySelector('[data-browser-host="true"]')?.style.visibility === 'visible');
	await page.frameLocator('[data-browser-host="true"] iframe').getByText('Browser test page').waitFor({ state: 'visible' });
	await page.locator('button:has(svg.lucide-panel-right)').first().click();
	await page.getByRole('menuitemcheckbox', { name: /浏览器|Browser/ }).click();
	await page.keyboard.press('Escape');
	await page.waitForFunction(() => document.querySelector('[data-browser-host="true"]')?.style.visibility === 'hidden');
	await page.locator('#tour-browser-nav').click();
	await page.waitForURL(/\/browser$/);
	await page.waitForFunction(() => document.querySelector('[data-browser-host="true"]')?.style.visibility === 'visible');
	assert.deepEqual(errors, [], `浏览器脚本错误：${errors.join(' | ')}`);
	console.log(`浏览器静止期样式写入 ${idleWrites} 次；网页加载、缩放、全屏与侧栏切换、隐藏/恢复：通过`);
} finally {
	await browser.close();
	server.closeAllConnections?.();
	await Promise.race([new Promise(resolve => server.close(resolve)), new Promise(resolve => setTimeout(resolve, 1000))]);
	rmSync(testHome, { recursive: true, force: true });
}
