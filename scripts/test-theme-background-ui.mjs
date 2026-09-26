// 隔离 ASAPI 与浏览器状态：验证主题页、预设/空白/自定义背景、重启持久化。
import { strict as assert } from 'node:assert';
import { createRequire } from 'node:module';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright-core');
const chrome = [process.env.COCODE_CHROME_PATH, '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', '/usr/bin/chromium'].find(path => path && existsSync(path));
if (!chrome) throw new Error('找不到 Chrome/Chromium，请设置 COCODE_CHROME_PATH');

const testHome = mkdtempSync(join(tmpdir(), 'cocode-theme-ui-'));
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
		window.cocodeVoice = { status: async () => ({ installed: true }), transcribe: async () => '' };
	});
	await page.goto(base + '/', { waitUntil: 'commit' });
	for (const [route, payload] of Object.entries({
		'auth/me': { id: 'theme-test', username: 'theme-test' },
		models: { models: [] },
		'polls/config': { enabled: true, entryVisible: false },
		'account/messages': { messages: [], unread: 0 },
		'account/events-ticket': { ticket: 'theme-test-ticket' },
	})) await page.route(`https://cocode.ohfun.online/${route}`, response => response.fulfill({
		status: 200, contentType: 'application/json', body: JSON.stringify(payload),
	}));
	await page.routeWebSocket('wss://cocode.ohfun.online/account/events*', socket => {
		socket.onMessage(message => { if (message === 'ping') socket.send('pong'); });
	});
	await page.evaluate(serverUrl => {
		localStorage.setItem('server_url', serverUrl);
		localStorage.setItem('cocode_auth_token', 'theme-test-token');
		localStorage.setItem('username', 'theme-test');
		localStorage.setItem('cocode:first-run:intro:v1', '1');
		localStorage.setItem('cocode:first-run:tour:v1', '1');
	}, base);
	await page.reload({ waitUntil: 'domcontentloaded' });
	await page.locator('#tour-chat-input').first().waitFor({ state: 'visible' });
	assert.equal(await page.evaluate(() => document.documentElement.dataset.appBackground), 'lavender');

	await page.getByRole('button', { name: /theme-test/i }).first().click();
	await page.getByText('设置', { exact: true }).first().click();
	await page.getByRole('heading', { name: '通用' }).waitFor({ state: 'visible' });
	assert.equal(await page.getByText('外观', { exact: true }).count(), 0, '通用页不应继续显示外观开关');
	await page.getByRole('button', { name: '主题', exact: true }).click();
	await page.getByRole('heading', { name: '主题' }).waitFor({ state: 'visible' });
	await page.waitForTimeout(350);
	await page.screenshot({ path: '/tmp/cocode-theme-settings-light.png' });

	await page.getByRole('button', { name: '雾蓝' }).click();
	assert.equal(await page.evaluate(() => localStorage.getItem('cocode.background')), 'mist');
	assert.equal(await page.evaluate(() => document.documentElement.dataset.appBackground), 'mist');
	await page.getByRole('button', { name: '无背景' }).click();
	assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector('.app-wallpaper')).backgroundImage), 'none');
	await page.getByRole('button', { name: '深夜' }).click();
	assert.equal(await page.evaluate(() => document.documentElement.dataset.appBackground), 'midnight');
	await page.getByRole('button', { name: '深色', exact: true }).click();
	assert.equal(await page.evaluate(() => document.documentElement.classList.contains('dark')), true);
	await page.waitForTimeout(200);
	await page.screenshot({ path: '/tmp/cocode-theme-settings-dark.png' });

	const uploadInput = page.locator('input[type="file"][accept="image/png,image/jpeg,image/webp"]');
	await uploadInput.setInputFiles({ name: 'invalid.txt', mimeType: 'text/plain', buffer: Buffer.from('not an image') });
	await page.getByRole('alert').getByText('请选择 PNG、JPEG 或 WebP 图片').waitFor({ state: 'visible' });
	assert.equal(await page.evaluate(() => document.documentElement.dataset.appBackground), 'midnight', '无效文件不得改变背景');
	const customFile = join(process.cwd(), 'packages/desktop/frontend/public/images/cocode-soft-backdrop.jpg');
	await uploadInput.setInputFiles(customFile);
	await page.waitForFunction(() => document.documentElement.dataset.appBackground === 'custom');
	const storedCustom = await page.evaluate(() => localStorage.getItem('cocode.background.custom'));
	assert.match(storedCustom, /^data:image\/jpeg;base64,/);
	assert.ok(storedCustom.length < 2_500_000);
	await page.reload({ waitUntil: 'domcontentloaded' });
	await page.waitForFunction(() => document.documentElement.dataset.appBackground === 'custom');
	assert.equal(await page.evaluate(() => document.documentElement.classList.contains('dark')), true, '颜色模式也应跨重载保留');

	await page.getByRole('button', { name: /theme-test/i }).first().click();
	await page.getByText('设置', { exact: true }).first().click();
	await page.getByRole('button', { name: '主题', exact: true }).click();
	await page.getByRole('button', { name: '移除自定义背景' }).click();
	assert.equal(await page.evaluate(() => localStorage.getItem('cocode.background.custom')), null);
	assert.equal(await page.evaluate(() => document.documentElement.dataset.appBackground), 'none');
	await page.getByRole('button', { name: '返回 CoCode' }).click();
	assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector('.app-wallpaper')).backgroundImage), 'none', '返回工作区后仍应无背景');
	assert.deepEqual(errors, [], `页面脚本错误：${errors.join(' | ')}`);
	console.log('主题页、预设背景、无背景、自定义导入与移除、深浅色及重载持久化：通过');
} finally {
	await browser.close();
	server.closeAllConnections?.();
	await Promise.race([new Promise(resolve => server.close(resolve)), new Promise(resolve => setTimeout(resolve, 1000))]);
	rmSync(testHome, { recursive: true, force: true });
}
