// 独立临时 ASAPI + 浏览器模拟 Electron 桥：验证首次启动与真实入口的点击链。
import { createRequire } from 'node:module';
import { strict as assert } from 'node:assert';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright-core');
const chrome = [process.env.TORA_CHROME_PATH, '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', '/usr/bin/chromium'].find(path => path && existsSync(path));
if (!chrome) throw new Error('找不到 Chrome/Chromium，请设置 TORA_CHROME_PATH');

const testHome = mkdtempSync(join(tmpdir(), 'tora-first-run-test-'));
process.env.TORA_HOME = testHome;
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
		window.toraWindow = {
			isMaximized: () => false, onMaximizeChange: () => {}, getSystemLocale: () => 'zh-CN',
			reportLanguage: () => {}, reportTheme: () => {}, getRequiredUpdate: () => null,
			onRequiredUpdate: () => () => {}, refreshAccount: async () => {},
			openFolderDialog: async () => null, onMenuCommand: () => () => {}, getAppVersion: () => '1.0.0',
		};
	});
	await page.goto(base + '/', { waitUntil: 'commit' });
	await page.route('https://tora.ohfun.online/auth/me', route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ id: 'first-run-test', username: 'first-run-test' }) }));
	await page.route('https://tora.ohfun.online/billing/subscription', route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ subscription: null, windows: [], remainingPercent: 0, canUseAgent: false, plans: [], extraPurchasesEnabled: false }) }));
await page.route('https://tora.ohfun.online/tochat/quota', route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ enabled: false, models: [], chatRemaining: 150, remainingPercent: 100, canUseAgent: true, subscription: {planId:'plus',name:'Tora Plus',expiresAt:'2099-01-01T00:00:00Z'}, windows: [{key:'fiveHour',remainingPercent:100,resetAt:null}], workDailyRemaining: 1000000, workWeeklyRemaining: 10000000 }) }));
await page.route('https://tora.ohfun.online/models', route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ models: [] }) }));
	await page.route('https://tora.ohfun.online/polls/config', route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ enabled: true, entryVisible: true }) }));
	await page.route('https://tora.ohfun.online/account/messages', route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ messages: [], unread: 0 }) }));
	await page.route('https://tora.ohfun.online/account/events-ticket', route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ticket: 'first-run-test-ticket' }) }));
	await page.routeWebSocket('wss://tora.ohfun.online/account/events*', socket => { socket.onMessage(message => { if (message === 'ping') socket.send('pong'); }); });
	await page.evaluate(serverUrl => {
		localStorage.setItem('server_url', serverUrl);
		localStorage.setItem('tora_auth_token', 'first-run-test-token');
		localStorage.setItem('username', 'first-run-test');
		localStorage.removeItem('tora:first-run:intro:v1');
		localStorage.removeItem('tora:first-run:tour:v1');
		localStorage.removeItem('tora:first-run:step:v1');
	}, base);
	await page.reload({ waitUntil: 'domcontentloaded' });
	await page.locator('.first-launch-root').waitFor({ state: 'visible' });
	await page.waitForFunction(() => document.querySelector('.first-launch-logo img')?.naturalWidth > 0);
	assert.equal(await page.locator('.first-launch-logo img').getAttribute('src'), '/icon.png', '欢迎页应使用 Tora Logo 资源');
	await page.waitForTimeout(1250);
	await page.screenshot({ path: '/tmp/tora-first-run-actual-intro.png' });
	assert.equal(await page.locator('.first-launch-status').count(), 0, '欢迎页不应保留旧的假加载状态');
	assert.equal(await page.locator('.first-launch-root').evaluate(element => element.scrollWidth <= element.clientWidth), true, '欢迎页不能横向溢出');
	await page.evaluate(() => document.documentElement.classList.add('dark'));
	await page.screenshot({ path: '/tmp/tora-first-run-actual-dark.png' });
	await page.evaluate(() => document.documentElement.classList.remove('dark'));
	await page.setViewportSize({ width: 390, height: 760 });
	assert.equal(await page.locator('.first-launch-root').evaluate(element => element.scrollWidth <= element.clientWidth), true, '窄窗口下欢迎页不能横向溢出');
	assert.ok(await page.getByRole('button', { name: /开启体验/ }).isVisible(), '窄窗口下开始按钮必须可见');
	await page.screenshot({ path: '/tmp/tora-first-run-actual-mobile.png' });
	await page.setViewportSize({ width: 1360, height: 850 });
	await page.getByRole('button', { name: /开启体验/ }).click();
	const consent = page.getByRole('dialog', { name: /开始使用前/ });
	await consent.waitFor({ state: 'visible' });
	await page.screenshot({ path: '/tmp/tora-first-use-consent-light.png' });
	await page.evaluate(() => document.documentElement.classList.add('dark'));
	await page.screenshot({ path: '/tmp/tora-first-use-consent-dark.png' });
	await page.evaluate(() => document.documentElement.classList.remove('dark'));
	assert.equal(await consent.getByRole('button', { name: /确认并继续/ }).isDisabled(), true, '三项确认前不能进入登录或工作区');
	for (const [name, url] of [
		[/用户协议/, 'https://ohfun.online/#terms'],
		[/隐私政策/, 'https://ohfun.online/#privacy'],
		[/跨境传输个人信息/, 'https://ohfun.online/#cross-border'],
	]) {
		await consent.getByRole('checkbox', { name }).check();
		assert.ok(await consent.locator(`a[href="${url}"]`).count(), `应提供 ${url} 的正式链接`);
	}
	await consent.getByRole('button', { name: /确认并继续/ }).click();
	assert.equal(JSON.parse(await page.evaluate(() => localStorage.getItem('tora:first-use-consent:v1'))).crossBorder, true, '跨境同意须单独记录');
	await page.locator('#tour-llm-select').first().waitFor({ state: 'visible' });
	const greeting = page.getByRole('heading', { name: 'Tora要构建些什么？' }).first();
	await greeting.waitFor({ state: 'visible' });
	assert.equal(await greeting.locator('.chat-greeting-character').count(), Array.from('Tora要构建些什么？').length, '空会话标题应按字拆分播放动画');
	const characterDelays = await greeting.locator('.chat-greeting-character').evaluateAll(elements => elements.map(element => Number.parseFloat(getComputedStyle(element).animationDelay)));
	assert.ok(characterDelays.every((delay, index) => index === 0 || delay > characterDelays[index - 1]), '标题动画应按文字顺序逐字播放');
	assert.ok(characterDelays.at(-1) > 0.5, '标题应保留之前较从容的逐字节奏');
	assert.equal(await greeting.locator('.chat-greeting-cursor').count(), 0, '不应恢复后来添加的快速指针动画');
	const sessionsBefore = (await (await fetch(`${base}/sessions/`)).json()).sessions.length;
	await page.locator('.first-run-coach').waitFor({ state: 'visible' });
	const spotlight = page.locator('.first-run-focus');
	await spotlight.waitFor({ state: 'visible' });
	const targetBox = await page.locator('#tour-llm-select').first().boundingBox();
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
	await page.screenshot({ path: '/tmp/tora-first-run-spotlight-model.png' });
	await page.locator('#tour-llm-select').first().click();
	await page.getByRole('heading', { name: '添加模型服务' }).waitFor({ state: 'visible' });
	await page.locator('#tour-add-model').click();
	await page.getByText('返回 Tora').waitFor({ state: 'visible' });
	await page.getByText('返回 Tora').click();
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
	await page.screenshot({ path: '/tmp/tora-first-run-spotlight-moving.png' });
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
	await page.getByRole('button', { name: /进入 Tora/ }).click();
	await greeting.waitFor({ state: 'visible' });
	await page.waitForFunction(() => {
		const endings = [...document.querySelectorAll('h1[aria-label="Tora要构建些什么？"] .chat-greeting-character:last-child')];
		return endings.length > 0 && endings.every(element => getComputedStyle(element).opacity === '1');
	});
	assert.ok(await page.locator('h1[aria-label="Tora要构建些什么？"] .chat-greeting-character').evaluateAll(elements => elements.every(element => getComputedStyle(element).opacity === '1')), '逐字动画结束后不得缺字');
	await page.screenshot({ path: '/tmp/tora-greeting-typewriter-complete.png' });
	assert.equal(await page.evaluate(() => localStorage.getItem('tora:first-run:tour:v1')), '1');
	await page.route('https://tora.ohfun.online/supporters?page=*', route => {
		const pageNumber = Number(new URL(route.request().url()).searchParams.get('page'));
		return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(pageNumber === 1
			? { page: 1, month: '2026-09', hasMore: true, supporters: [] }
			: { page: 2, month: '2026-09', hasMore: false, supporters: [{ name: '赞助者甲' }, { name: '赞助者乙' }] }) });
	});
	await page.evaluate(() => {
		window.__sponsorOpens = [];
		window.open = url => { window.__sponsorOpens.push(url); return null; };
	});
	await page.getByRole('button', { name: /first-run-test/i }).first().click();
	await page.getByRole('menuitem', { name: '本月赞助者名单' }).click();
	await page.getByRole('dialog', { name: '本月赞助者名单' }).waitFor({ state: 'visible' });
	await page.getByText('当前页暂无本月赞助者，可继续加载更多。').waitFor({ state: 'visible' });
	await page.getByRole('button', { name: '加载更多' }).click();
	await page.getByText('赞助者甲').waitFor({ state: 'visible' });
	await page.getByText('赞助者乙').waitFor({ state: 'visible' });
	await page.getByText('共 2 位赞助者').waitFor({ state: 'visible' });
	await page.getByRole('button', { name: '赞助', exact: true }).click();
	assert.deepEqual(await page.evaluate(() => window.__sponsorOpens), [], '确认之前不能打开赞助外链');
	await page.getByRole('button', { name: '确认并打开' }).click();
	assert.deepEqual(await page.evaluate(() => window.__sponsorOpens), ['https://ifdian.net/a/zhenxun111']);
	await page.getByRole('button', { name: /first-run-test/i }).first().click();
	await page.getByRole('menuitem', { name: '赞助', exact: true }).click();
	await page.getByRole('dialog', { name: /前往爱发电赞助/ }).waitFor({ state: 'visible' });
	await page.getByRole('button', { name: '取消' }).click();
	assert.equal((await page.evaluate(() => window.__sponsorOpens)).length, 1, '取消时不得打开外链');
	await page.reload({ waitUntil: 'domcontentloaded' });
	await page.locator('#tour-llm-select').first().waitFor({ state: 'visible' });
	assert.equal(await page.locator('.first-launch-root').count(), 0, '再次启动不应重复播放开场');
	assert.equal(await page.locator('.first-run-coach').count(), 0, '再次启动不应重复引导');
	await page.getByRole('button', { name: /first-run-test/i }).first().click();
	await page.getByRole('menuitem', { name: /^(语言|Language)$/ }).click();
	await page.getByRole('dialog', { name: /^(语言|Language)$/ }).getByRole('button', { name: 'English / 英语' }).click();
	await page.getByRole('button', { name: /first-run-test/i }).first().click();
	assert.equal(await page.getByRole('menuitem', { name: 'Replay the getting-started guide' }).count(), 0, '账号菜单不应再显示重新查看新手引导');
	await page.keyboard.press('Escape');
	await page.emulateMedia({ reducedMotion: 'reduce' });
	await page.evaluate(() => {
		localStorage.removeItem('tora:first-run:intro:v1');
		localStorage.removeItem('tora:first-run:tour:v1');
		localStorage.removeItem('tora:first-run:step:v1');
	});
	await page.reload({ waitUntil: 'domcontentloaded' });
	await page.getByRole('dialog', { name: /first-launch welcome animation/i }).waitFor({ state: 'visible' });
	assert.equal(await page.locator('.first-launch-logo').evaluate(element => getComputedStyle(element).animationName), 'none', '减少动态效果时不应播放入场动画');
	await page.getByRole('button', { name: /Skip animation/ }).click();
	await page.locator('#tour-llm-select').first().waitFor({ state: 'visible' });
	const englishGreeting = page.getByRole('heading', { name: 'What should Tora build?' }).first();
	await englishGreeting.waitFor({ state: 'visible' });
	assert.equal(await englishGreeting.locator('.chat-greeting-character').first().evaluate(element => getComputedStyle(element).animationName), 'none', '减少动态效果时标题应直接完整显示');
	await page.getByRole('heading', { name: 'Choose your own model' }).waitFor({ state: 'visible' });
	await page.locator('#tour-llm-select').first().click();
	await page.getByRole('button', { name: 'Set up later' }).click();
	await page.getByRole('heading', { name: 'Set your project scope' }).waitFor({ state: 'visible' });
	await page.locator('#tour-workspace-picker').click();
	await page.getByRole('button', { name: 'Set up later' }).click();
	await page.getByRole('heading', { name: 'Stay in control' }).waitFor({ state: 'visible' });
	await page.locator('#tour-permission-mode').click();
	if (await page.getByRole('button', { name: 'Set up later' }).count()) await page.getByRole('button', { name: 'Set up later' }).click();
	await page.getByRole('heading', { name: 'Describe a clear goal' }).waitFor({ state: 'visible', timeout: 5000 });
	await page.getByRole('button', { name: /Skip guide/ }).click();
	await page.getByRole('button', { name: /Enter Tora/ }).click();

	// 未登录的新安装用户先看开场，再进入登录页；教学不得压在认证表单之上。
	const unsigned = await browser.newPage({ viewport: { width: 1024, height: 760 }, locale: 'zh-CN' });
	await unsigned.addInitScript(() => { window.quitRequested = false; window.toraWindow = { isMaximized: () => false, onMaximizeChange: () => {}, getSystemLocale: () => 'zh-CN', getRequiredUpdate: () => null, onRequiredUpdate: () => () => {}, quitApp: () => { window.quitRequested = true; } }; });
	await unsigned.goto(base + '/', { waitUntil: 'domcontentloaded' });
	await unsigned.locator('.first-launch-root').waitFor({ state: 'visible' });
	await unsigned.getByRole('button', { name: /开启体验/ }).click();
	await unsigned.getByRole('dialog', { name: /开始使用前/ }).waitFor({ state: 'visible' });
	await unsigned.getByRole('button', { name: /暂不接受并退出/ }).click();
	assert.equal(await unsigned.evaluate(() => window.quitRequested), true, '拒绝协议应请求退出应用');
	assert.equal(await unsigned.evaluate(() => localStorage.getItem('tora:first-use-consent:v1')), null, '拒绝时不得保存同意记录');
	await unsigned.locator('#consent-terms').check();
	await unsigned.locator('#consent-privacy').check();
	await unsigned.locator('#consent-cross-border').check();
	await unsigned.getByRole('button', { name: /确认并继续/ }).click();
	await unsigned.locator('input[autocomplete="username"]').waitFor({ state: 'visible' });
	assert.equal(await unsigned.locator('.first-run-coach').count(), 0, '未登录时不得显示主界面引导');
	await unsigned.close();
	assert.deepEqual(errors, [], `浏览器出现脚本错误：${errors.join(' | ')}`);
	console.log('首次动画、11 步真实入口与安全演示、完成后不重复展示、移除重播入口与减少动态效果：通过');
} finally {
	await browser.close();
	server.closeAllConnections?.();
	await Promise.race([new Promise(resolve => server.close(resolve)), new Promise(resolve => setTimeout(resolve, 1000))]);
	rmSync(testHome, { recursive: true, force: true });
}
