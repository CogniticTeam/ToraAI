// 隔离 ASAPI 与浏览器状态：验证主题页、预设/空白/自定义背景、重启持久化。
import { strict as assert } from 'node:assert';
import { createRequire } from 'node:module';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {createSystemFontService} from '../packages/desktop/system-fonts.js';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright-core');
const chrome = [process.env.TORA_CHROME_PATH, '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', '/usr/bin/chromium'].find(path => path && existsSync(path));
if (!chrome) throw new Error('找不到 Chrome/Chromium，请设置 TORA_CHROME_PATH');

const testHome = mkdtempSync(join(tmpdir(), 'tora-theme-ui-'));
process.env.TORA_HOME = testHome;
const { startASAPIServer } = await import('../packages/core/src/asapi/server.js');
const server = await startASAPIServer({ port: 0 });
const base = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ headless: true, executablePath: chrome, args: ['--no-sandbox'] });

try {
	const systemFonts=await createSystemFontService()();
	const chosenFont=systemFonts.find(name=>/Noto Serif|DejaVu Serif|Georgia/i.test(name))||systemFonts[0];
	const page = await browser.newPage({ viewport: { width: 1360, height: 850 }, locale: 'zh-CN' });
	const errors = [];
	const runtimeRequests=[];page.on('request',request=>{if(new URL(request.url()).pathname==='/admin/runtime')runtimeRequests.push(request.url());});
	page.on('pageerror', error => errors.push(error.message));
	await page.addInitScript(fonts => {
		window.toraFonts={list:async()=>({status:'ready',families:fonts})};
		window.toraWindow = {
			isMaximized: () => false, onMaximizeChange: () => {}, getSystemLocale: () => 'zh-CN',
			reportLanguage: () => {}, reportTheme: () => {}, getRequiredUpdate: () => null,
			onRequiredUpdate: () => () => {}, refreshAccount: async () => {},
			openFolderDialog: async () => null, onMenuCommand: () => () => {}, getAppVersion: () => '1.0.0',
		};
		window.toraVoice = { status: async () => ({ installed: true }), transcribe: async () => '' };
	},systemFonts);
	await page.goto(base + '/', { waitUntil: 'commit' });
	for (const [route, payload] of Object.entries({
		'auth/me': { id: 'theme-test', username: 'theme-test' },
		models: { models: [] },
		'polls/config': { enabled: true, entryVisible: false },
		'account/messages': { messages: [], unread: 0 },
		'account/events-ticket': { ticket: 'theme-test-ticket' },
	})) await page.route(`https://tora.ohfun.online/${route}`, response => response.fulfill({
		status: 200, contentType: 'application/json', body: JSON.stringify(payload),
	}));
	await page.routeWebSocket('wss://tora.ohfun.online/account/events*', socket => {
		socket.onMessage(message => { if (message === 'ping') socket.send('pong'); });
	});
	await page.evaluate(serverUrl => {
		localStorage.setItem('server_url', serverUrl);
		localStorage.setItem('tora_auth_token', 'theme-test-token');
		localStorage.setItem('username', 'theme-test');
		localStorage.setItem('tora:first-run:intro:v1', '1');
		localStorage.setItem('tora:first-use-consent:v1', JSON.stringify({ terms: true, privacy: true, crossBorder: true }));
		localStorage.setItem('tora:first-run:tour:v1', '1');
	}, base);
	await page.reload({ waitUntil: 'domcontentloaded' });
	await page.locator('#tour-chat-input').first().waitFor({ state: 'visible' });
	assert.equal(await page.evaluate(() => document.documentElement.dataset.appBackground), 'lavender');

	await page.getByRole('button', { name: /theme-test/i }).first().click();
	await page.getByText('设置', { exact: true }).first().click();
	await page.getByRole('heading', { name: '通用' }).waitFor({ state: 'visible' });
	assert.equal(await page.getByRole('button',{name:'开发者&调试',exact:true}).count(),0);
	await page.evaluate(()=>window.dispatchEvent(new CustomEvent('tora:open-settings',{detail:'developer'})));
	await page.getByRole('heading',{name:'通用',exact:true}).waitFor({state:'visible'});
	await page.screenshot({path:'/tmp/tora-settings-without-debug.png'});
	assert.equal(await page.getByText('外观', { exact: true }).count(), 0, '通用页不应继续显示外观开关');
	const settings = page.getByRole('dialog', { name: '设置', exact: true });
	assert.equal(await settings.isVisible(), true);
	assert.equal(await page.getByRole('switch', { name: '提示音', exact: true }).count(), 1);
	const headingSize = await page.getByRole('heading', { name: '通用', exact: true }).evaluate(el => getComputedStyle(el).fontSize);
	await page.setViewportSize({ width: 960, height: 600 });
	const volume = page.getByRole('combobox', { name: '音量', exact: true });
	assert.match(await volume.textContent(), /60%/, '默认音量应显示实际值');
	await volume.click();
	const volumeMenu = page.getByRole('listbox');
	const bounds = await volumeMenu.boundingBox();
	assert.ok(bounds.y >= 0 && bounds.y + bounds.height <= 600, '窗口底部的选项应完整显示');
	await page.waitForFunction(() => document.activeElement?.getAttribute('role') === 'option' && document.activeElement.textContent.includes('60%'));
	await page.keyboard.press('ArrowDown');
	await page.waitForFunction(() => document.activeElement?.getAttribute('role') === 'option' && document.activeElement.textContent.includes('75%'));
	await page.keyboard.press('Enter');
	await page.waitForFunction(() => JSON.parse(localStorage.getItem('tora_sound') || '{}').volume === 0.75);
	await settings.getByRole('button', { name: '账号', exact: true }).click();
	assert.equal(await page.getByRole('heading', { name: '账号', exact: true }).evaluate(el => getComputedStyle(el).fontSize), headingSize, '账号与通用页标题应一致');
	await page.keyboard.press('Escape');
	await settings.waitFor({ state: 'hidden' });
	await page.waitForFunction(() => document.activeElement?.getAttribute('data-testid') === 'account-menu-trigger', null, { timeout: 5000 });
	assert.equal(await page.getByRole('button', { name: /theme-test/i }).first().evaluate(el => el === document.activeElement), true, '关闭设置后焦点应回到账户入口');
	await page.getByRole('button', { name: /theme-test/i }).first().click();
	await page.getByText('设置', { exact: true }).first().click();
	await page.setViewportSize({ width: 1360, height: 850 });

	await page.getByRole('button', { name: '主题', exact: true }).click();
	await page.getByRole('heading', { name: '主题' }).waitFor({ state: 'visible' });
	assert.equal(await page.getByTestId('theme-font-section').evaluate(el=>el===el.parentElement.lastElementChild),true,'字体应位于主题设置最后');
	const fontSelect=page.getByTestId('theme-font-select');
	const heights = await page.getByTestId('theme-font-section').locator('input,button,select').evaluateAll(elements => elements.map(el => el.getBoundingClientRect().height));
	assert.deepEqual(heights, [40, 40, 40], '字体搜索、刷新与选择控件应等高');

	await page.waitForFunction(()=>document.querySelector('[data-testid="theme-font-select"]')?.options.length>1);
	assert.equal(await fontSelect.locator('option').count(),systemFonts.length+1);
	await page.getByRole('textbox',{name:'搜索字体',exact:true}).fill(chosenFont);
	await fontSelect.selectOption(chosenFont);
	assert.equal(await page.evaluate(()=>localStorage.getItem('tora.theme.font')),chosenFont);
	assert.ok((await page.getByTestId('theme-font-preview').evaluate(el=>getComputedStyle(el).fontFamily)).includes(chosenFont));
	await page.screenshot({path:'/tmp/tora-theme-font-settings.png'});
	await page.getByRole('textbox',{name:'搜索字体',exact:true}).fill('');
	await page.waitForTimeout(350);
	await page.screenshot({ path: '/tmp/tora-theme-settings-light.png' });

	await page.getByRole('button', { name: '雾蓝' }).click();
	assert.equal(await page.evaluate(() => localStorage.getItem('tora.background')), 'mist');
	assert.equal(await page.evaluate(() => document.documentElement.dataset.appBackground), 'mist');
	await page.getByRole('button', { name: '无背景' }).click();
	assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector('.app-wallpaper')).backgroundImage), 'none');
	await page.getByRole('button', { name: '深夜' }).click();
	assert.equal(await page.evaluate(() => document.documentElement.dataset.appBackground), 'midnight');
	await page.getByRole('button', { name: '深色', exact: true }).click();
	assert.equal(await page.evaluate(() => document.documentElement.classList.contains('dark')), true);
	await page.waitForFunction(()=>[...document.querySelectorAll('.app-wallpaper')].every(el=>getComputedStyle(el).backgroundColor==='rgb(27, 27, 26)'));
	assert.equal(await page.locator('[data-sidebar=footer]').evaluate(el=>getComputedStyle(el.parentElement).backgroundColor),'rgb(27, 27, 26)');
	assert.ok(await page.locator('.app-wallpaper').last().evaluate(el=>getComputedStyle(el).backgroundImage.includes('tora-midnight.jpg')),'原有深色预设背景应恢复显示');
	await page.waitForTimeout(200);
	await page.screenshot({ path: '/tmp/tora-theme-settings-dark.png' });

	const uploadInput = page.locator('input[type="file"][accept="image/png,image/jpeg,image/webp"]');
	await uploadInput.setInputFiles({ name: 'invalid.txt', mimeType: 'text/plain', buffer: Buffer.from('not an image') });
	await page.getByRole('alert').getByText('请选择 PNG、JPEG 或 WebP 图片').waitFor({ state: 'visible' });
	assert.equal(await page.evaluate(() => document.documentElement.dataset.appBackground), 'midnight', '无效文件不得改变背景');
	const customFile = join(process.cwd(), 'packages/desktop/frontend/public/images/tora-soft-backdrop.jpg');
	await uploadInput.setInputFiles(customFile);
	await page.waitForFunction(() => document.documentElement.dataset.appBackground === 'custom');
	await page.waitForFunction(()=>[...document.querySelectorAll('.app-wallpaper')].every(el=>getComputedStyle(el).backgroundImage.includes('data:image/jpeg')));
	const storedCustom = await page.evaluate(() => localStorage.getItem('tora.background.custom'));
	assert.match(storedCustom, /^data:image\/jpeg;base64,/);
	assert.ok(storedCustom.length < 2_500_000);
	await page.reload({ waitUntil: 'domcontentloaded' });
	await page.waitForFunction(() => document.documentElement.dataset.appBackground === 'custom');
	assert.ok((await page.locator('#tour-chat-textarea').evaluate(el=>getComputedStyle(el).fontFamily)).includes(chosenFont),'字体在重载后应保持');
	assert.equal(await page.evaluate(() => document.documentElement.classList.contains('dark')), true, '颜色模式也应跨重载保留');
	assert.ok(await page.locator('.app-wallpaper').first().evaluate(el=>getComputedStyle(el).backgroundImage.includes('data:image/jpeg')),'深色自定义背景在重载后必须可见');
	await page.screenshot({path:'/tmp/tora-custom-background-dark.png'});

	await page.getByRole('button', { name: /theme-test/i }).first().click();
	await page.getByText('设置', { exact: true }).first().click();
	await page.getByRole('button', { name: '主题', exact: true }).click();
	await page.getByRole('button',{name:'浅色',exact:true}).click();
	await page.waitForFunction(()=>!document.documentElement.classList.contains('dark'));
	assert.ok(await page.locator('.app-wallpaper').last().evaluate(el=>getComputedStyle(el).backgroundImage.includes('data:image/jpeg')),'浅色自定义背景也必须可见');
	await page.getByRole('button',{name:'深色',exact:true}).click();
	await page.waitForFunction(()=>document.documentElement.classList.contains('dark'));
	await page.getByTestId('theme-font-select').selectOption('');
	assert.equal(await page.evaluate(()=>localStorage.getItem('tora.theme.font')),null);
	assert.equal(await page.evaluate(()=>document.documentElement.style.getPropertyValue('--tora-ui-font')),'');
	await page.getByRole('button', { name: '移除自定义背景' }).click();
	assert.equal(await page.evaluate(() => localStorage.getItem('tora.background.custom')), null);
	assert.equal(await page.evaluate(() => document.documentElement.dataset.appBackground), 'none');
	await page.getByRole('button', { name: '返回 Tora' }).click();
	assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector('.app-wallpaper')).backgroundImage), 'none', '返回工作区后仍应无背景');

	await page.getByRole('button', { name: /theme-test/i }).first().click();
	await page.getByText('设置', { exact: true }).first().click();
	await page.getByRole('button', { name: '数据管理', exact: true }).click();
	await page.getByRole('button', { name: '导入聊天记录', exact: true }).click();
	await page.getByTestId('session-import-dialog').waitFor({ state: 'visible' });
	await page.getByRole('dialog', { name: '设置', exact: true }).waitFor({ state: 'hidden' });
	await page.keyboard.press('Escape');
	await page.getByTestId('session-import-dialog').waitFor({ state: 'hidden' });
	assert.deepEqual(runtimeRequests,[],'设置页不应读取或改写内部运行配置');
	assert.deepEqual(errors, [], `页面脚本错误：${errors.join(' | ')}`);
	console.log('主题页、预设背景、无背景、自定义导入与移除、深浅色及重载持久化：通过');
} finally {
	await browser.close();
	server.closeAllConnections?.();
	await Promise.race([new Promise(resolve => server.close(resolve)), new Promise(resolve => setTimeout(resolve, 1000))]);
	rmSync(testHome, { recursive: true, force: true });
}
