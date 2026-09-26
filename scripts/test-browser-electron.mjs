// 隔离 Electron 进程 + 临时 ASAPI：验证真正的 webview 能加载、切换与恢复。
import { createRequire } from 'node:module';
import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { _electron } = require('playwright-core');
const electronBinary = require('electron');
const testHome = mkdtempSync(join(tmpdir(), 'cocode-browser-electron-'));
process.env.COCODE_HOME = testHome;
const { startASAPIServer } = await import('../packages/core/src/asapi/server.js');
const server = await startASAPIServer({ port: 0 });
const base = `http://127.0.0.1:${server.address().port}`;
let electronApp;

try {
	electronApp = await _electron.launch({
		executablePath: electronBinary,
		args: [fileURLToPath(new URL('./browser-electron-harness.cjs', import.meta.url))],
		env: { ...process.env, COCODE_BROWSER_TEST_USER_DATA: testHome },
	});
	const page = await electronApp.firstWindow();
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
	await page.route('https://cocode.ohfun.online/auth/me', route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ id: 'browser-electron-test', username: 'browser-electron-test' }) }));
	await page.route('https://cocode.ohfun.online/models', route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ models: [] }) }));
	await page.route('https://cocode.ohfun.online/polls/config', route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ enabled: true, entryVisible: true }) }));
	await page.route('https://cocode.ohfun.online/account/messages', route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ messages: [], unread: 0 }) }));
	await page.route('https://cocode.ohfun.online/account/events-ticket', route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ticket: 'browser-electron-ticket' }) }));
	await page.routeWebSocket('wss://cocode.ohfun.online/account/events*', socket => { socket.onMessage(message => { if (message === 'ping') socket.send('pong'); }); });
	await page.goto(base + '/', { waitUntil: 'domcontentloaded' });
	await page.evaluate(serverUrl => {
		localStorage.setItem('server_url', serverUrl);
		localStorage.setItem('cocode_auth_token', 'browser-electron-token');
		localStorage.setItem('username', 'browser-electron-test');
		localStorage.setItem('cocode:first-run:intro:v1', '1');
		localStorage.setItem('cocode:first-run:tour:v1', '1');
	}, base);
	await page.reload({ waitUntil: 'domcontentloaded' });
	await page.locator('#tour-llm-select').first().waitFor({ state: 'visible' });
	await page.locator('button:has(svg.lucide-panel-right)').first().click();
	await page.getByRole('menuitemcheckbox', { name: /浏览器|Browser/ }).click();
	await page.keyboard.press('Escape');
	await page.locator('[data-browser-placeholder="true"]').waitFor({ state: 'visible' });
	await page.waitForFunction(() => Boolean(window.__cocodeBrowser));
	const opened = await page.evaluate(async url => window.__cocodeBrowser.call('open', { url }), `${base}/health`);
	assert.equal(opened.url, `${base}/health`);
	const webviewUrl = await page.locator('[data-browser-host="true"] webview').evaluate(element => element.getURL());
	assert.equal(webviewUrl, `${base}/health`);
	await page.waitForTimeout(600);
	const idleWrites = await page.locator('[data-browser-host="true"]').evaluate(element => new Promise(resolve => {
		let count = 0;
		const observer = new MutationObserver(events => { count += events.length; });
		observer.observe(element, { attributes: true, attributeFilter: ['style'] });
		setTimeout(() => { observer.disconnect(); resolve(count); }, 350);
	}));
	assert.ok(idleWrites <= 2, `Electron WebView 静止时宿主不应持续重写样式：${idleWrites}`);
	await page.locator('button:has(svg.lucide-panel-right)').first().click();
	await page.getByRole('menuitemcheckbox', { name: /浏览器|Browser/ }).click();
	await page.keyboard.press('Escape');
	await page.waitForFunction(() => document.querySelector('[data-browser-host="true"]')?.style.visibility === 'hidden');
	await page.locator('#tour-browser-nav').click();
	await page.waitForURL(/\/browser$/);
	await page.waitForFunction(() => document.querySelector('[data-browser-host="true"]')?.style.visibility === 'visible');
	assert.equal(await page.locator('[data-browser-host="true"] webview').evaluate(element => element.getURL()), `${base}/health`);
	await page.getByRole('button', { name: /新任务/ }).first().click();
	await page.waitForURL(/\/chat(?:\/|$)/);
	await page.waitForFunction(() => document.querySelector('[data-browser-host="true"]')?.style.visibility === 'hidden');
	await page.locator('button:has(svg.lucide-panel-right)').first().click();
	await page.getByRole('menuitemcheckbox', { name: /浏览器|Browser/ }).click();
	await page.keyboard.press('Escape');
	try {
		await page.waitForFunction(() => document.querySelector('[data-browser-host="true"]')?.style.visibility === 'visible', undefined, { timeout: 5000 });
	} catch {
		throw new Error(`WebView 宿主未恢复：${JSON.stringify(await page.evaluate(() => ({ host: document.querySelector('[data-browser-host="true"]')?.getAttribute('style'), placeholders: document.querySelectorAll('[data-browser-placeholder="true"]').length, bridge: Boolean(window.__cocodeBrowser), text: document.body.innerText.slice(-500) })))}`);
	}
	assert.equal(await page.locator('[data-browser-host="true"] webview').evaluate(element => element.getURL()), `${base}/health`);
	assert.deepEqual(errors, [], `渲染进程脚本错误：${errors.join(' | ')}`);
	console.log(`Electron WebView 实际加载与恢复通过；静止期宿主样式写入 ${idleWrites} 次`);
} finally {
	await electronApp?.close();
	server.closeAllConnections?.();
	await Promise.race([new Promise(resolve => server.close(resolve)), new Promise(resolve => setTimeout(resolve, 1000))]);
	rmSync(testHome, { recursive: true, force: true });
}
