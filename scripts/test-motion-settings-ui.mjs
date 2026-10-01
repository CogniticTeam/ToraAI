// 隔离本地前端：验证动画偏好、点击反馈、路由切换及系统减少动态效果。
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright-core';

const chrome = [process.env.TORA_CHROME_PATH, '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome'].find(path => path && existsSync(path));
if (!chrome) throw new Error('找不到 Chrome/Chromium');
const testHome = mkdtempSync(join(tmpdir(), 'tora-motion-settings-'));
process.env.TORA_HOME = testHome;
const { startASAPIServer } = await import('../packages/core/src/asapi/server.js');
const server = await startASAPIServer({ port: 0 });
const base = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ headless: true, executablePath: chrome, args: ['--no-sandbox'] });

try {
	const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, locale: 'zh-CN', reducedMotion: 'no-preference' });
	const errors = [];
	page.on('pageerror', error => errors.push(error.message));
	await page.addInitScript(() => {
		window.toraWindow = {
			isMaximized: () => false, onMaximizeChange: () => {}, getSystemLocale: () => 'zh-CN',
			reportLanguage: () => {}, reportTheme: () => {}, getRequiredUpdate: () => null,
			onRequiredUpdate: () => () => {}, refreshAccount: async () => {},
			openFolderDialog: async () => null, onMenuCommand: () => () => {}, getAppVersion: () => '1.0.1',
		};
	});
	await page.goto(base + '/', { waitUntil: 'commit' });
	for (const [path, body] of Object.entries({
		'auth/me': { id: 'motion-test', username: 'motion-test' },
		models: { models: [] },
		'polls/config': { enabled: false, entryVisible: false },
		'account/messages': { messages: [], unread: 0 },
		'account/events-ticket': { ticket: 'motion-test-ticket' },
	})) await page.route(`https://tora.ohfun.online/${path}`, route => route.fulfill({
		status: 200, contentType: 'application/json', body: JSON.stringify(body),
	}));
	await page.routeWebSocket('wss://tora.ohfun.online/account/events*', socket => {
		socket.onMessage(message => { if (message === 'ping') socket.send('pong'); });
	});
	await page.evaluate(serverUrl => {
		localStorage.setItem('server_url', serverUrl);
		localStorage.setItem('tora_auth_token', 'motion-test-token');
		localStorage.setItem('username', 'motion-test');
		localStorage.setItem('tora:first-run:intro:v1', '1');
		localStorage.setItem('tora:first-run:tour:v1', '1');
		localStorage.setItem('tora:first-use-consent:v1', JSON.stringify({ terms: true, privacy: true, crossBorder: true }));
	}, base);
	await page.reload({ waitUntil: 'domcontentloaded' });
	await page.locator('#tour-chat-input').first().waitFor({ state: 'visible' });
	assert.equal(await page.evaluate(() => document.documentElement.dataset.motion), 'standard');

	await page.getByRole('button', { name: /motion-test/i }).first().click();
	await page.getByText('设置', { exact: true }).first().click();
	await page.getByRole('button', { name: '主题', exact: true }).click();
	await page.getByRole('heading', { name: '主题' }).waitFor({ state: 'visible' });
	const pace = page.getByRole('group', { name: '动画节奏' });
	await pace.getByRole('button', { name: '快速' }).click();
	assert.equal(await page.evaluate(() => localStorage.getItem('tora.motion.mode')), 'fast');
	assert.equal(await page.evaluate(() => document.documentElement.dataset.motion), 'fast');
	assert.equal(await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--tora-click-duration').trim()), '85ms');
	const fastButton = pace.getByRole('button', { name: '快速' });
	await fastButton.hover();
	await page.mouse.down();
	await page.waitForTimeout(100);
	const pressedScale = await fastButton.evaluate(element => new DOMMatrix(getComputedStyle(element).transform).a);
	assert.ok(pressedScale < 1 && pressedScale > 0.9, `点击反馈应轻微缩放，实际 ${pressedScale}`);
	await page.mouse.up();
	await page.screenshot({ path: '/tmp/tora-motion-settings.png' });
	await page.getByRole('button', { name: '深色', exact: true }).click();
	await page.waitForTimeout(350);
	await page.screenshot({ path: '/tmp/tora-motion-settings-dark.png' });

	await page.getByRole('switch', { name: '点击反馈' }).click();
	assert.equal(await page.evaluate(() => document.documentElement.dataset.motionClick), 'off');
	await fastButton.hover();
	await page.mouse.down();
	assert.equal(await fastButton.evaluate(element => new DOMMatrix(getComputedStyle(element).transform).a), 1, '只关闭点击反馈也不得缩放');
	await page.mouse.up();
	await page.getByRole('switch', { name: '页面切换' }).click();
	assert.equal(await page.evaluate(() => document.documentElement.dataset.motionPage), 'off');
	await pace.getByRole('button', { name: '关闭' }).click();
	assert.equal(await page.evaluate(() => document.documentElement.dataset.motion), 'off');
	const offButton = pace.getByRole('button', { name: '关闭' });
	await offButton.hover();
	await page.mouse.down();
	assert.equal(await offButton.evaluate(element => new DOMMatrix(getComputedStyle(element).transform).a), 1, '关闭动画后按钮不应缩放');
	await page.mouse.up();
	await page.reload({ waitUntil: 'domcontentloaded' });
	assert.equal(await page.evaluate(() => document.documentElement.dataset.motion), 'off', '重载前就应应用保存的偏好');
	assert.equal(await page.evaluate(() => document.documentElement.dataset.motionClick), 'off');

	await page.getByRole('button', { name: /motion-test/i }).first().click();
	await page.getByText('设置', { exact: true }).first().click();
	await page.getByRole('button', { name: '主题', exact: true }).click();
	await pace.getByRole('button', { name: '标准' }).click();
	await page.getByRole('switch', { name: '点击反馈' }).click();
	await page.getByRole('switch', { name: '页面切换' }).click();
	await page.getByRole('button', { name: '返回 Tora' }).click();
	await page.getByRole('button', { name: '自动化' }).click();
	await page.waitForURL('**/schedule');
	await page.waitForFunction(() => document.activeElement?.getAttribute('tabindex') === '-1');
	assert.equal(await page.evaluate(() => getComputedStyle(document.activeElement).outlineStyle), 'none', '页面聚焦不应出现整圈边框');
	await page.getByRole('button', { name: '浏览器' }).click();
	await page.waitForURL('**/browser');
	await page.emulateMedia({ reducedMotion: 'reduce' });
	await page.waitForFunction(() => document.documentElement.dataset.motion === 'off');
	assert.equal(await page.evaluate(() => document.documentElement.dataset.motionClick), 'off');
	const reducedDuration = await page.getByRole('button', { name: '技能中心' }).evaluate(element => getComputedStyle(element).transitionDuration);
	assert.ok(reducedDuration.split(',').every(value => parseFloat(value) < 0.001), `减少动态后仍有过渡：${reducedDuration}`);
	await page.getByRole('button', { name: '技能中心' }).click();
	await page.waitForURL('**/skill');
	await page.goBack({ waitUntil: 'domcontentloaded' });
	await page.waitForURL('**/browser');
	assert.deepEqual(errors, []);
	console.log('动画档位、点击与页面开关、持久化、路由和系统减少动态效果：通过');
} finally {
	await browser.close();
	server.closeAllConnections?.();
	await Promise.race([new Promise(resolve => server.close(resolve)), new Promise(resolve => setTimeout(resolve, 1000))]);
	rmSync(testHome, { recursive: true, force: true });
}
