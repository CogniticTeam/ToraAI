// 独立临时 ASAPI + 浏览器模拟 Electron 桥：验证首次启动与真实入口的点击链。
import { createRequire } from 'node:module';
import { strict as assert } from 'node:assert';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright-core');
const chrome = [process.env.COCODE_CHROME_PATH, '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', '/usr/bin/chromium'].find(path => path && existsSync(path));
if (!chrome) throw new Error('找不到 Chrome/Chromium，请设置 COCODE_CHROME_PATH');

const testHome = mkdtempSync(join(tmpdir(), 'cocode-first-run-test-'));
process.env.COCODE_HOME = testHome;
const { startASAPIServer } = await import('../packages/core/src/asapi/server.js');
const server = await startASAPIServer({ port: 0 });
const base = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ headless: true, executablePath: chrome, args: ['--no-sandbox'] });

try {
	const page = await browser.newPage({ viewport: { width: 1360, height: 850 }, locale: 'zh-CN' });
	const errors = [];
	page.on('pageerror', error => { errors.push(error.message); console.error('浏览器脚本错误：', error.message); });
	let actualMessageRequests = 0;
	page.on('request', request => { if (/\/chat(?:\/|$)/.test(new URL(request.url()).pathname) && request.method() === 'POST') actualMessageRequests++; });
	await page.addInitScript(() => {
		window.cocodeWindow = {
			isMaximized: () => false, onMaximizeChange: () => {}, getSystemLocale: () => 'zh-CN',
			reportLanguage: () => {}, reportTheme: () => {}, getRequiredUpdate: () => null,
			onRequiredUpdate: () => () => {}, refreshAccount: async () => {},
			openFolderDialog: async () => null, onMenuCommand: () => () => {}, getAppVersion: () => '1.0.0',
		};
	});
	await page.goto(base + '/', { waitUntil: 'commit' });
	await page.route('https://cocode.ohfun.online/auth/me', route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ id: 'first-run-test', username: 'first-run-test' }) }));
	await page.route('https://cocode.ohfun.online/models', route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ models: [] }) }));
	await page.route('https://cocode.ohfun.online/polls/config', route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ enabled: true, entryVisible: true }) }));
	await page.route('https://cocode.ohfun.online/account/messages', route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ messages: [], unread: 0 }) }));
	await page.route('https://cocode.ohfun.online/account/events-ticket', route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ticket: 'first-run-test-ticket' }) }));
	await page.routeWebSocket('wss://cocode.ohfun.online/account/events*', socket => { socket.onMessage(message => { if (message === 'ping') socket.send('pong'); }); });
	await page.evaluate(serverUrl => {
		localStorage.setItem('server_url', serverUrl);
		localStorage.setItem('cocode_auth_token', 'first-run-test-token');
		localStorage.setItem('username', 'first-run-test');
		localStorage.removeItem('cocode:first-run:intro:v1');
		localStorage.removeItem('cocode:first-run:tour:v1');
		localStorage.removeItem('cocode:first-run:step:v1');
	}, base);
	await page.reload({ waitUntil: 'domcontentloaded' });
	await page.locator('.first-launch-root').waitFor({ state: 'visible' });
	await page.screenshot({ path: '/tmp/cocode-first-run-actual-intro.png' });
	await page.locator('.first-launch-status').filter({ hasText: /准备完成/ }).waitFor({ state: 'visible', timeout: 5000 });
	await page.screenshot({ path: '/tmp/cocode-first-run-actual-ready.png' });
	await page.getByRole('button', { name: /开启体验/ }).click();
	await page.locator('#tour-llm-select').first().waitFor({ state: 'visible' });
	const greeting = page.getByRole('heading', { name: '与CoCode工作和编程' }).first();
	await greeting.waitFor({ state: 'visible' });
	assert.equal(await greeting.locator('.chat-greeting-character').count(), Array.from('与CoCode工作和编程').length, '空会话标题应按字拆分播放动画');
	const characterDelays = await greeting.locator('.chat-greeting-character').evaluateAll(elements => elements.map(element => Number.parseFloat(getComputedStyle(element).animationDelay)));
	assert.ok(characterDelays.every((delay, index) => index === 0 || delay > characterDelays[index - 1]), '标题动画应按文字顺序逐字播放');
	assert.ok(characterDelays.at(-1) > 0.5, '标题应保留之前较从容的逐字节奏');
	assert.equal(await greeting.locator('.chat-greeting-cursor').count(), 0, '不应恢复后来添加的快速指针动画');
	const sessionsBefore = (await (await fetch(`${base}/sessions/`)).json()).sessions.length;
	await page.locator('.first-run-coach').waitFor({ state: 'visible' });
	const spotlight = page.locator('.first-run-focus');
	await spotlight.waitFor({ state: 'visible' });
	const targetBox = await page.locator('#tour-llm-select').boundingBox();
	const focusBox = await spotlight.boundingBox();
	assert.ok(targetBox && focusBox, '模型按钮和聚光框应同时可见');
	assert.ok(Math.abs(focusBox.x - targetBox.x + 3) < 1 && Math.abs(focusBox.y - targetBox.y + 3) < 1, '聚光框应贴合目标位置');
	assert.ok(Math.abs(focusBox.width - targetBox.width - 6) < 1 && Math.abs(focusBox.height - targetBox.height - 6) < 1, '聚光框应贴合目标尺寸');
	const focusStyle = await spotlight.evaluate(element => ({ radius: getComputedStyle(element).borderTopLeftRadius, shadow: getComputedStyle(element).boxShadow }));
	assert.ok(Number.parseFloat(focusStyle.radius) >= 12 && !focusStyle.shadow.includes('9999px'), '聚光框应有圆角，且不使用巨大阴影覆盖全屏');
	assert.equal(await page.locator('.first-run-shade').count(), 4, '应由四块轻量遮罩覆盖聚光框外侧');
	assert.equal(await page.locator('.first-run-corner').count(), 4, '圆角开口应由四块小型角遮罩补齐');
	const shadeStyle = await page.locator('.first-run-shade').first().evaluate(element => ({ transform: getComputedStyle(element).transform, width: getComputedStyle(element).width }));
	assert.notEqual(shadeStyle.transform, 'none', '遮罩应由合成层缩放定位');
	assert.equal(shadeStyle.width, '1px', '遮罩应从轻量 1px 实色层缩放，避免全屏阴影绘制');
	await page.screenshot({ path: '/tmp/cocode-first-run-spotlight-model.png' });
	await page.locator('#tour-llm-select').click();
	await page.getByRole('heading', { name: '添加模型服务' }).waitFor({ state: 'visible' });
	await page.locator('#tour-add-model').click();
	await page.getByText('返回 CoCode').waitFor({ state: 'visible' });
	await page.getByText('返回 CoCode').click();
	await page.locator('#tour-workspace-picker').click();
	await page.keyboard.press('Escape');
	await page.locator('#tour-permission-mode').click();
	await page.keyboard.press('Escape');
	await page.locator('#tour-chat-textarea').click();
	await page.getByRole('button', { name: /演示发送/ }).click();
	await page.locator('#first-run-demo-approve').click();
	const beforeMove = await spotlight.boundingBox();
	await page.locator('#first-run-demo-checkpoint').click();
	await page.waitForTimeout(80);
	const motionFrame = await page.evaluate(() => {
		const focus = document.querySelector('.first-run-focus');
		const shades = [...document.querySelectorAll('.first-run-shade')];
		return {
			focus: focus?.getBoundingClientRect().toJSON(),
			shades: shades.map(element => element.getBoundingClientRect().toJSON()),
			transform: focus ? getComputedStyle(focus).transform : 'none',
			animation: focus ? getComputedStyle(focus).animationName : 'none',
		};
	});
	await page.screenshot({ path: '/tmp/cocode-first-run-spotlight-moving.png' });
	const skillsBox = await page.locator('#tour-skills-nav').boundingBox();
	assert.ok(beforeMove && motionFrame.focus && skillsBox, '跨区域切换时聚光框应保持可见');
	assert.ok(Math.abs(motionFrame.focus.x - beforeMove.x) > 8 && Math.abs(motionFrame.focus.x - skillsBox.x) > 8, '聚光框应连续移动，而非瞬间跳到下一个控件');
	assert.notEqual(motionFrame.transform, 'none', '聚光框移动应使用合成层 transform，而不是逐帧修改布局坐标');
	assert.equal(motionFrame.animation, 'none', '聚光框不应持续重绘全屏阴影脉冲');
	assert.ok(Math.abs(motionFrame.shades[0].bottom - motionFrame.focus.y) < 3
		&& Math.abs(motionFrame.shades[1].right - motionFrame.focus.x) < 3
		&& Math.abs(motionFrame.shades[2].left - motionFrame.focus.right) < 3
		&& Math.abs(motionFrame.shades[3].top - motionFrame.focus.bottom) < 3,
	'动画中每一帧的遮罩开口都应与圆角聚光框对齐');
	await page.locator('#tour-skills-nav').click();
	await page.locator('#tour-browser-nav').click();
	await page.locator('#tour-automation-nav').click();
	await page.getByRole('dialog', { name: /准备好了/ }).waitFor({ state: 'visible' });
	assert.equal(actualMessageRequests, 0, '教学演示不得向真实聊天端点发送消息');
	assert.equal((await (await fetch(`${base}/sessions/`)).json()).sessions.length, sessionsBefore, '教学演示不得创建真实会话');
	await page.getByRole('button', { name: /进入 CoCode/ }).click();
	await greeting.waitFor({ state: 'visible' });
	await page.waitForFunction(() => {
		const endings = [...document.querySelectorAll('h1[aria-label="与CoCode工作和编程"] .chat-greeting-character:last-child')];
		return endings.length > 0 && endings.every(element => getComputedStyle(element).opacity === '1');
	});
	assert.ok(await page.locator('h1[aria-label="与CoCode工作和编程"] .chat-greeting-character').evaluateAll(elements => elements.every(element => getComputedStyle(element).opacity === '1')), '逐字动画结束后不得缺字');
	await page.screenshot({ path: '/tmp/cocode-greeting-typewriter-complete.png' });
	assert.equal(await page.evaluate(() => localStorage.getItem('cocode:first-run:tour:v1')), '1');
	await page.reload({ waitUntil: 'domcontentloaded' });
	await page.locator('#tour-llm-select').first().waitFor({ state: 'visible' });
	assert.equal(await page.locator('.first-launch-root').count(), 0, '再次启动不应重复播放开场');
	assert.equal(await page.locator('.first-run-coach').count(), 0, '再次启动不应重复引导');
	await page.getByRole('button', { name: /first-run-test/i }).first().click();
	await page.getByText('Switch to English').click();
	await page.emulateMedia({ reducedMotion: 'reduce' });
	await page.getByRole('button', { name: /first-run-test/i }).first().click();
	await page.getByText('Replay the getting-started guide').click();
	await page.getByRole('dialog', { name: /first-launch welcome animation/i }).waitFor({ state: 'visible' });
	assert.equal(await page.locator('.first-launch-mark').evaluate(element => getComputedStyle(element).animationName), 'none', '减少动态效果时不应播放入场动画');
	await page.getByRole('button', { name: /Skip animation/ }).click();
	await page.locator('#tour-llm-select').first().waitFor({ state: 'visible' });
	const englishGreeting = page.getByRole('heading', { name: 'Work and Code with CoCode' }).first();
	await englishGreeting.waitFor({ state: 'visible' });
	assert.equal(await englishGreeting.locator('.chat-greeting-character').first().evaluate(element => getComputedStyle(element).animationName), 'none', '减少动态效果时标题应直接完整显示');
	await page.getByRole('heading', { name: 'Choose your own model' }).waitFor({ state: 'visible' });
	await page.locator('#tour-llm-select').click();
	await page.getByRole('button', { name: 'Set up later' }).click();
	await page.getByRole('heading', { name: 'Set your project scope' }).waitFor({ state: 'visible' });
	await page.locator('#tour-workspace-picker').click();
	await page.getByRole('button', { name: 'Set up later' }).click();
	await page.getByRole('heading', { name: 'Stay in control' }).waitFor({ state: 'visible' });
	await page.locator('#tour-permission-mode').click();
	if (await page.getByRole('button', { name: 'Set up later' }).count()) await page.getByRole('button', { name: 'Set up later' }).click();
	await page.getByRole('heading', { name: 'Describe a clear goal' }).waitFor({ state: 'visible', timeout: 5000 });
	await page.getByRole('button', { name: /Skip guide/ }).click();
	await page.getByRole('button', { name: /Enter CoCode/ }).click();

	// 未登录的新安装用户先看开场，再进入登录页；教学不得压在认证表单之上。
	const unsigned = await browser.newPage({ viewport: { width: 1024, height: 760 }, locale: 'zh-CN' });
	await unsigned.addInitScript(() => { window.cocodeWindow = { isMaximized: () => false, onMaximizeChange: () => {}, getSystemLocale: () => 'zh-CN', getRequiredUpdate: () => null, onRequiredUpdate: () => () => {} }; });
	await unsigned.goto(base + '/', { waitUntil: 'domcontentloaded' });
	await unsigned.locator('.first-launch-root').waitFor({ state: 'visible' });
	await unsigned.getByRole('button', { name: /开启体验/ }).click();
	await unsigned.locator('input[autocomplete="username"]').waitFor({ state: 'visible' });
	assert.equal(await unsigned.locator('.first-run-coach').count(), 0, '未登录时不得显示主界面引导');
	await unsigned.close();
	assert.deepEqual(errors, [], `浏览器出现脚本错误：${errors.join(' | ')}`);
	console.log('首次动画、11 步真实入口与安全演示、完成后不重复展示、英文重播与减少动态效果：通过');
} finally {
	await browser.close();
	server.closeAllConnections?.();
	await Promise.race([new Promise(resolve => server.close(resolve)), new Promise(resolve => setTimeout(resolve, 1000))]);
	rmSync(testHome, { recursive: true, force: true });
}
