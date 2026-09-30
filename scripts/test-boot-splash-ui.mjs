// 隔离浏览器延迟主脚本：确认静态首帧可见、主题正确、React 就绪后自动退场。
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright-core';

const chrome = [process.env.TORA_CHROME_PATH, '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', '/usr/bin/chromium'].find(path => path && existsSync(path));
if (!chrome) throw new Error('找不到 Chrome/Chromium，请设置 TORA_CHROME_PATH');
const html = readFileSync(new URL('../packages/desktop/frontend/dist/index.html', import.meta.url), 'utf8');
const entry = html.match(/<script type="module" crossorigin src="([^"]+)"/)?.[1];
assert.ok(entry, '前端构建必须包含主脚本');

const testHome = mkdtempSync(join(tmpdir(), 'tora-boot-splash-'));
process.env.TORA_HOME = testHome;
const { startASAPIServer } = await import('../packages/core/src/asapi/server.js');
const server = await startASAPIServer({ port: 0 });
const base = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ headless: true, executablePath: chrome, args: ['--no-sandbox'] });

try {
	for (const dark of [false, true]) {
		const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, colorScheme: dark ? 'dark' : 'light' });
		const errors = [];
		page.on('pageerror', error => errors.push(error.message));
		let release;
		const bundleGate = new Promise(resolve => { release = resolve; });
		await page.route(`${base}${entry}`, async route => { await bundleGate; await route.continue(); });
		await page.goto(base + '/', { waitUntil: 'commit' });
		const splash = page.locator('#boot-splash');
		await splash.waitFor({ state: 'visible' });
		await page.waitForFunction(() => document.querySelector('#boot-splash .startup-loading-mark')?.naturalWidth > 0);
		const before = await splash.evaluate(element => ({
			position: getComputedStyle(element).position,
			mark: element.querySelector('img')?.getAttribute('src'),
			blur: getComputedStyle(element, '::before').filter,
			filter: getComputedStyle(element.querySelector('img')).filter,
			background: getComputedStyle(element).backgroundColor,
		}));
		assert.equal(before.position, 'fixed');
		assert.equal(before.mark, '/tora-mark-transparent.png');
		assert.match(before.blur, /blur\(38px\)/);
		assert.equal(before.filter.includes('invert(1)'), dark, '深色主题应使用白色品牌符号');
		if (process.env.TORA_BOOT_TEST_OUTPUT) {
			// 主脚本被刻意挂起时 document.fonts.ready 也会等待；直接截取当前合成帧。
			const cdp = await page.context().newCDPSession(page);
			const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
			writeFileSync(join(process.env.TORA_BOOT_TEST_OUTPUT, dark ? 'boot-dark.png' : 'boot-light.png'), Buffer.from(shot.data, 'base64'));
			await cdp.detach();
		}
		release();
		await splash.waitFor({ state: 'detached', timeout: 15000 });
		assert.ok(await page.locator('#root').evaluate(element => element.childElementCount > 0), '加载层只能在 React 页面已经挂载后退场');
		assert.deepEqual(errors, [], `浏览器脚本错误：${errors.join(' | ')}`);
		await page.close();
	}
	console.log('静态毛玻璃首帧、透明 Tora 标志、深浅色和 React 就绪后退场：通过');
} finally {
	await browser.close();
	server.closeAllConnections?.();
	await Promise.race([new Promise(resolve => server.close(resolve)), new Promise(resolve => setTimeout(resolve, 1000))]);
	rmSync(testHome, { recursive: true, force: true });
}
