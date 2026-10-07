// 独立临时 ASAPI：验证新输入卡片的真实控件、项目状态条与响应式布局。
import { createRequire } from 'node:module';
import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright-core');
const chrome = [process.env.TORA_CHROME_PATH, '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', '/usr/bin/chromium'].find(path => path && existsSync(path));
if (!chrome) throw new Error('找不到 Chrome/Chromium，请设置 TORA_CHROME_PATH');

function contrastRatio(foreground, background) {
	const rgb = value => value.startsWith('#')
		? (value.length === 4 ? [...value.slice(1)].map(part => part + part) : value.slice(1).match(/.{2}/g)).map(part => parseInt(part, 16))
		: value.match(/[\d.]+/g).slice(0, 3).map(Number);
	const luminance = value => rgb(value).map(channel => {
		const normalized = channel / 255;
		return normalized <= 0.04045 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
	}).reduce((sum, channel, index) => sum + channel * [0.2126, 0.7152, 0.0722][index], 0);
	const values = [luminance(foreground), luminance(background)].sort((a, b) => b - a);
	return (values[0] + 0.05) / (values[1] + 0.05);
}

const testHome = mkdtempSync(join(tmpdir(), 'tora-composer-ui-'));
const project = join(testHome, 'Tora');
mkdirSync(project);
execFileSync('git', ['init', '-b', 'main', project], { stdio: 'ignore' });
process.env.TORA_HOME = testHome;
const { startASAPIServer } = await import('../packages/core/src/asapi/server.js');
const { loadSessionRecord, saveSessionRecord } = await import('../packages/core/src/asapi/store.js');
const { userMsg } = await import('../packages/core/src/asapi/protocol.js');
const server = await startASAPIServer({ port: 0 });
const base = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ headless: true, executablePath: chrome, args: ['--no-sandbox'] });

try {
	const page = await browser.newPage({ viewport: { width: 1360, height: 850 }, locale: 'zh-CN' });
	const errors = [];
	page.on('pageerror', error => errors.push(error.message));
	await page.addInitScript(folder => {
		window.toraWindow = {
			isMaximized: () => false, onMaximizeChange: () => {}, getSystemLocale: () => 'zh-CN',
			reportLanguage: () => {}, reportTheme: () => {}, getRequiredUpdate: () => null,
			onRequiredUpdate: () => () => {}, refreshAccount: async () => {},
			openFolderDialog: async () => folder, onMenuCommand: () => () => {}, getAppVersion: () => '1.0.0',
		};
		window.toraVoice = { status: async () => ({ installed: true }), transcribe: async () => '' };
	}, project);
	await page.goto(base + '/', { waitUntil: 'commit' });
	await page.route('https://tora.ohfun.online/auth/me', route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ id: 'composer-test', username: 'composer-test' }) }));
	let cloudModels = [];
	await page.route('https://tora.ohfun.online/billing/subscription', route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ subscription: null, windows: [], remainingPercent: 0, canUseAgent: false, plans: [], extraPurchasesEnabled: false }) }));
await page.route('https://tora.ohfun.online/tochat/quota', route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ enabled: false, models: [], chatRemaining: 150, remainingPercent: 100, canUseAgent: true, subscription: {planId:'plus',name:'Tora Plus',expiresAt:'2099-01-01T00:00:00Z'}, windows: [{key:'fiveHour',remainingPercent:100,resetAt:null}], workDailyRemaining: 1000000, workWeeklyRemaining: 10000000 }) }));
await page.route('https://tora.ohfun.online/models', route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ models: cloudModels }) }));
	await page.route('https://tora.ohfun.online/polls/config', route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ enabled: true, entryVisible: true }) }));
	await page.route('https://tora.ohfun.online/account/messages', route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ messages: [], unread: 0 }) }));
	await page.route('https://tora.ohfun.online/account/events-ticket', route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ticket: 'composer-test-ticket' }) }));
	await page.routeWebSocket('wss://tora.ohfun.online/account/events*', socket => { socket.onMessage(message => { if (message === 'ping') socket.send('pong'); }); });
	await page.evaluate(serverUrl => {
		localStorage.setItem('server_url', serverUrl);
		localStorage.setItem('tora_auth_token', 'composer-test-token');
		localStorage.setItem('username', 'composer-test');
		localStorage.setItem('tora:first-run:intro:v1', '1');
		localStorage.setItem('tora:first-use-consent:v1', JSON.stringify({ terms: true, privacy: true, crossBorder: true }));
		localStorage.setItem('tora:first-run:tour:v1', '1');
	}, base);
	await page.reload({ waitUntil: 'domcontentloaded' });
	const card = page.locator('#tour-chat-input').first();
	await card.waitFor({ state: 'visible' });
	await page.locator('#tour-workspace-picker').first().click();
	await page.locator('[data-slot="popover-content"]').getByRole('button', { name: '选择文件夹', exact: true }).click();
	await page.locator('#tour-workspace-picker').first().getByText('Tora').waitFor({ state: 'visible' });
	await page.locator('#tour-permission-mode').first().click();
	await page.getByRole('menuitemradio', { name: /完全访问/ }).click();
	await page.keyboard.press('Escape');
	await page.getByRole('menu').waitFor({ state: 'hidden' });
	assert.equal(await page.getByText('本地', { exact: true }).count(), 0, '新聊天项目条不应再显示本地标签');
	assert.equal(await page.locator('.composer-context svg.lucide-git-branch').count(), 0, '新聊天项目条不应再显示 Git 按钮');
	await page.waitForFunction(() => [...document.querySelectorAll('.chat-greeting-character')].every(element => getComputedStyle(element).opacity === '1'));
	await page.mouse.move(100, 50);
	await page.locator('#tour-chat-textarea').first().focus();
	await page.waitForTimeout(250);
	assert.equal(await page.locator('#tour-chat-textarea').first().getAttribute('placeholder'), '随心输入');
	const colors = await page.evaluate(() => {
		const root = getComputedStyle(document.documentElement);
		const textarea = document.querySelector('#tour-chat-textarea');
		return {
			tertiary: root.getPropertyValue('--text-tertiary').trim(),
			sidebar: root.getPropertyValue('--sidebar').trim(),
			background: root.getPropertyValue('--background').trim(),
			placeholder: getComputedStyle(textarea, '::placeholder').color,
		};
	});
	assert.ok(contrastRatio(colors.tertiary, colors.sidebar) >= 4.5, '侧栏时间的对比度应至少达到 4.5:1');
	assert.ok(contrastRatio(colors.placeholder, colors.background) >= 4.5, `输入占位文字的对比度应至少达到 4.5:1（${JSON.stringify(colors)}）`);
	const greeting = page.getByRole('heading', { level: 1 }).first();
	const greetingFont = await greeting.evaluate(element => parseFloat(getComputedStyle(element).fontSize));
	assert.ok(greetingFont >= 30 && greetingFont <= 40, '欢迎标题应使用克制的响应式字号');
	assert.ok(await card.getByRole('button', { name: /完全访问/ }).count(), '权限控件应在卡片底部');
	assert.ok(await card.locator('#tour-llm-select').count(), '模型控件应在卡片底部');
	assert.ok(await card.locator('#tour-send-button').count(), '发送控件应在卡片底部');
	const sendButtonBox = await card.locator('#tour-send-button').boundingBox();
	assert.equal(sendButtonBox?.width, 30, '发送按钮应保持 30px 的紧凑尺寸');
	assert.equal(sendButtonBox?.height, 30, '发送按钮应保持圆形');
	assert.ok(await card.locator('svg.lucide-mic').count(), '语音控件应保留');
	const contextBox = await page.locator('.composer-context').first().boundingBox();
	const cardBox = await card.boundingBox();
	assert.ok(contextBox && cardBox && contextBox.y < cardBox.y && cardBox.height >= 90 && cardBox.height <= 112
		&& cardBox.width >= 700 && cardBox.width <= 750,
		'状态条应位于约 736px 宽、100px 高的输入卡片上方');
	const textarea = page.locator('#tour-chat-textarea').first();
	const initialTextHeight = (await textarea.boundingBox()).height;
	await textarea.fill('第一行\n第二行\n第三行\n第四行\n第五行\n第六行\n第七行');
	await page.waitForFunction(before => document.querySelector('#tour-chat-textarea')?.getBoundingClientRect().height > before, initialTextHeight);
	assert.ok((await textarea.boundingBox()).height <= 170, '多行输入应增高，但不能无限挤占聊天内容');
	await textarea.fill('');
	await page.waitForFunction(before => document.querySelector('#tour-chat-textarea')?.getBoundingClientRect().height <= before, initialTextHeight);
	await page.screenshot({ path: '/tmp/tora-composer-light.png' });
	await page.evaluate(() => document.documentElement.classList.add('dark'));
	await page.waitForTimeout(250);
	if (process.env.TORA_DEBUG_COMPOSER) console.log('composer colors', await page.evaluate(() => ['#tour-workspace-picker', '#tour-llm-select', '#tour-permission-mode', '.composer-context', '#tour-chat-input'].map(selector => { const element = document.querySelector(selector); const style = element ? getComputedStyle(element) : null; return { selector, color: style?.color, background: style?.backgroundColor }; })));
	await page.screenshot({ path: '/tmp/tora-composer-dark.png' });
	await page.setViewportSize({ width: 960, height: 700 });
	await page.waitForFunction(() => {
		const card = document.querySelector('#tour-chat-input');
		const send = document.querySelector('#tour-send-button');
		if (!card || !send) return false;
		const a = card.getBoundingClientRect(); const b = send.getBoundingClientRect();
		return b.left >= a.left && b.right <= a.right && b.bottom <= a.bottom;
	});
	await page.screenshot({ path: '/tmp/tora-composer-narrow.png' });
	await page.evaluate(folder => {
		localStorage.setItem('tora-project-names-v1', JSON.stringify({ [folder]: '超长项目名称用于验证标题可以自动换行而不会超出窗口' }));
		window.dispatchEvent(new Event('tora-project-names-changed'));
	}, project);
	await page.getByRole('heading', { level: 1, name: /超长项目名称/ }).waitFor({ state: 'visible' });
	await page.waitForFunction(() => [...document.querySelectorAll('.chat-greeting-character')].every(element => getComputedStyle(element).opacity === '1'));
	const longGreetingBox = await page.getByRole('heading', { level: 1 }).first().boundingBox();
	assert.ok(longGreetingBox && longGreetingBox.x >= 0 && longGreetingBox.x + longGreetingBox.width <= 960 && longGreetingBox.height >= 70,
		'长项目名在窄窗口应换行且不超出视口');
	await page.screenshot({ path: '/tmp/tora-composer-long-project.png' });
	await page.evaluate(() => {
		localStorage.removeItem('tora-project-names-v1');
		window.dispatchEvent(new Event('tora-project-names-changed'));
	});
	const agentId = (await (await fetch(`${base}/agent/`)).json()).agents[0].id;
	const { session_id: sessionId } = await (await fetch(`${base}/sessions/`, {
		method: 'POST', headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ agent_id: agentId, cwd: project }),
	})).json();
	await page.setViewportSize({ width: 1360, height: 850 });
	await page.goto(`${base}/chat/${agentId}/${sessionId}`, { waitUntil: 'domcontentloaded' });
	await page.locator('#tour-chat-input').first().waitFor({ state: 'visible' });
	await page.locator('.composer-context').waitFor({ state: 'visible' });
	await page.locator('#tour-workspace-picker').waitFor({ state: 'visible' });
	assert.equal(await page.locator('#tour-workspace-picker').count(), 1, '已有 ID 但尚无消息的欢迎页仍应显示项目状态栏');
	await page.screenshot({ path: '/tmp/tora-composer-empty-session.png' });
	const record = loadSessionRecord(sessionId);
	record.display = [userMsg('已有消息测试')];
	saveSessionRecord(record);
	await page.reload({ waitUntil: 'domcontentloaded' });
	await page.getByText('已有消息测试', { exact: true }).first().waitFor({ state: 'visible' });
	assert.equal(await page.locator('.composer-context').count(), 0, '真正进入有消息的会话后应隐藏整条项目状态栏');
	assert.equal(await page.locator('#tour-workspace-picker').count(), 0, '有消息的会话不应残留文件夹按钮');
	const existingCard = await page.locator('#tour-chat-input').first().boundingBox();
	assert.ok(existingCard && existingCard.height >= 90 && existingCard.height <= 112, '隐藏状态栏后输入卡片不能出现负边距或异常高度');
	assert.equal(await page.locator('#tour-llm-select').first().count(), 1);
	assert.equal(await page.locator('#tour-permission-mode').first().count(), 1);
	await page.screenshot({ path: '/tmp/tora-composer-existing.png' });
	// 图像附件必须转为 data URL，不能把本机路径送给模型。
	cloudModels = [{ id: 'deepseek-ui-test', provider: 'deepseek', label: 'DeepSeek', model: 'deepseek-flash', baseURL: 'https://api.deepseek.com/v1', apiKey: 'test', enabled: true, vision: null }];
	const { saveConfig } = await import('../packages/core/src/config.js');
	saveConfig({ modelList: cloudModels });
	record.config.chat_model_config = { type: 'openai_compatible', credential_id: 'cocode-models', model: 'deepseek-flash', parameters: {} };
	saveSessionRecord(record);
	await page.reload({ waitUntil: 'domcontentloaded' });
	const fileInput = page.locator('#tour-chat-input input[type="file"]');
	await page.waitForFunction(() => document.querySelector('#tour-chat-input input[type="file"]')?.accept.includes('image/png'));
	await fileInput.setInputFiles({ name: 'sample.png', mimeType: 'image/png', buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9W4YtuwAAAAASUVORK5CYII=', 'base64') });
	const image = page.locator('img[alt="sample.png"]');
	await image.waitFor({ state: 'visible' });
	assert.match(await image.getAttribute('src'), /^data:image\/png;base64,/, '图片附件应内联，不得传 file://');
	const previousFetch = globalThis.fetch;
	let modelRequest = null;
	globalThis.fetch = async (_url, init) => {
		const body = JSON.parse(init?.body || '{}');
		if (body.messages?.some(message => Array.isArray(message.content) && message.content.some(part => part.type === 'image_url'))) modelRequest = body;
		return new Response('data: {"choices":[{"delta":{"content":"图片已收到"}}]}\n\ndata: [DONE]\n\n', { status: 200, headers: { 'content-type': 'text/event-stream' } });
	};
	try {
		await page.locator('#tour-chat-textarea').first().fill('描述图片');
		await page.locator('#tour-chat-textarea').first().press('Enter');
		for (let attempt = 0; attempt < 100 && !modelRequest; attempt++) await new Promise(resolve => setTimeout(resolve, 50));
		const user = modelRequest?.messages.find(message => Array.isArray(message.content) && message.content.some(part => part.type === 'image_url'));
		assert.match(user?.content.find(part => part.type === 'image_url')?.image_url?.url || '', /^data:image\/png;base64,/, '发往模型的图片必须是 data URL');
	} finally { globalThis.fetch = previousFetch; }
	// ToChat switches rows for both manual newlines and wrapping, then shrinks.
	await page.evaluate(() => localStorage.setItem('tora_tochat_source', 'custom'));
	await page.goto(`${base}/tochat/${agentId}?task=chat`, {waitUntil:'domcontentloaded'});
	const capsule = page.locator('.composer-shell[data-composer-variant="capsule"]');
	const chatEditor = capsule.locator('textarea');
	await capsule.waitFor({state:'visible'});
	await page.locator('#tour-model-selector').click();
	await page.getByRole('button', {name:'deepseek-flash',exact:true}).click();
	const expectRows = async expanded => {
		await page.waitForFunction(expected => {
			const shell = document.querySelector('.composer-shell[data-composer-variant="capsule"]');
			if (!shell || shell.dataset.multiline !== String(expected)) return false;
			const editor = shell.querySelector('.composer-editor').getBoundingClientRect();
			const button = shell.querySelector('#tour-send-button').getBoundingClientRect();
			return expected ? button.top >= editor.bottom : button.top < editor.bottom;
		}, expanded);
	};
	await chatEditor.fill('第一行'); await expectRows(false);
	await chatEditor.press('Shift+Enter'); await expectRows(true);
	await chatEditor.fill('自动换行测试'.repeat(30)); await expectRows(true);
	await page.waitForTimeout(200); await expectRows(true); // no expand/collapse oscillation
	await page.setViewportSize({width:960,height:700}); await expectRows(true);
	await page.screenshot({path:'/tmp/tora-chat-composer-multiline.png'});
	await chatEditor.fill('你好'); await expectRows(false);
	await chatEditor.evaluate(element => {
		element.dispatchEvent(new CompositionEvent('compositionstart', {bubbles:true}));
		element.dispatchEvent(new CompositionEvent('compositionend', {bubbles:true,data:'你好'}));
		element.dispatchEvent(new KeyboardEvent('keydown', {bubbles:true,cancelable:true,key:'Enter',isComposing:false}));
		element.dispatchEvent(new KeyboardEvent('keyup', {bubbles:true,key:'Enter'}));
	});
	assert.equal(await chatEditor.inputValue(), '你好', '候选字确认不能清空输入或发送');
	assert.equal(new URL(page.url()).pathname, `/tochat/${agentId}`, '候选字确认不能创建会话');
	await chatEditor.fill(''); await expectRows(false);
	// Free Doubao remains available without a subscription, only in chat.
	await page.unroute('https://tora.ohfun.online/tochat/quota');
	await page.route('https://tora.ohfun.online/tochat/quota', route => route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({enabled:true,models:[{id:'deepseek-flash',enabled:true},{id:'doubao-seed-2-1-lite-260915',enabled:true}],chatUnlimited:true,canUseAgent:false,remainingPercent:0,subscription:null,windows:[]})}));
	await page.evaluate(() => localStorage.setItem('tora_tochat_source','official'));
	await page.goto(`${base}/tochat/${agentId}?task=chat`, {waitUntil:'domcontentloaded'});
	await page.getByRole('button',{name:'选择模型',exact:true}).click();
	await page.getByRole('menuitemradio',{name:/Doubao Seed 2.1 Lite/}).click();
	await page.waitForFunction(()=>document.querySelector('#tour-chat-textarea')?.disabled===false);
	assert.match(await page.locator('input[type="file"]').getAttribute('accept'),/audio\/wav/);
	assert.match(await page.locator('input[type="file"]').getAttribute('accept'),/video\/mp4/);
	await page.getByRole('button',{name:'选择模型',exact:true}).click();
	await page.screenshot({path:'/tmp/tora-doubao-chat-picker.png'});
	await page.keyboard.press('Escape');
	await page.getByRole('button',{name:'工作',exact:true}).click();
	await page.getByRole('button',{name:'选择模型',exact:true}).click();
	assert.equal(await page.getByRole('menuitemradio',{name:/Doubao/}).count(),0,'Work must hide Doubao');
	await page.keyboard.press('Escape');
	assert.deepEqual(errors, [], `浏览器脚本错误：${errors.join(' | ')}`);
	console.log('紧凑输入卡片与 DeepSeek 图片附件前端到模型请求全链路：通过');
} finally {
	await browser.close();
	server.closeAllConnections?.();
	await Promise.race([new Promise(resolve => server.close(resolve)), new Promise(resolve => setTimeout(resolve, 1000))]);
	rmSync(testHome, { recursive: true, force: true });
}
