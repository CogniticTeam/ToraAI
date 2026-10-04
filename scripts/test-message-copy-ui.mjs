// 独立临时 ASAPI：验证旧会话复制、气泡悬停、键盘聚焦与复制结果。
import { createRequire } from 'node:module';
import { strict as assert } from 'node:assert';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright-core');
const chrome = [process.env.TORA_CHROME_PATH, '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', '/usr/bin/chromium'].find(path => path && existsSync(path));
if (!chrome) throw new Error('找不到 Chrome/Chromium，请设置 TORA_CHROME_PATH');

const testHome = mkdtempSync(join(tmpdir(), 'tora-message-copy-'));
process.env.TORA_HOME = testHome;
const { startASAPIServer } = await import('../packages/core/src/asapi/server.js');
const { loadSessionRecord, saveSessionRecord } = await import('../packages/core/src/asapi/store.js');
const { userMsg, assistantMsgShell } = await import('../packages/core/src/asapi/protocol.js');
const server = await startASAPIServer({ port: 0 });
const base = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ headless: true, executablePath: chrome, args: ['--no-sandbox'] });
const userText = '用户复制测试';
const assistantText = '历史 AI 回复可复制';

try {
	const agentId = (await (await fetch(`${base}/agent/`)).json()).agents[0].id;
	const { session_id: sessionId } = await (await fetch(`${base}/sessions/`, {
		method: 'POST', headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ agent_id: agentId }),
	})).json();
	const record = loadSessionRecord(sessionId);
	const now = new Date().toISOString();
	const completed = assistantMsgShell('reply-legacy');
	completed.content = [{ id: 'text-legacy', type: 'text', text: assistantText, created_at: now, finished_at: now }];
	completed.finished_at = now; // 模拟已保存的旧消息：没有 finished_reason。
	const partial = assistantMsgShell('reply-partial');
	partial.content = [{ id: 'text-partial', type: 'text', text: '尚未结束的半截回复', created_at: now, finished_at: null }];
	record.display = [userMsg(userText), completed, userMsg('等待中'), partial];
	saveSessionRecord(record);

	const page = await browser.newPage({ viewport: { width: 1360, height: 850 }, locale: 'zh-CN' });
	const errors = [];
	page.on('pageerror', error => errors.push(error.message));
	await page.addInitScript(() => {
		window.toraWindow = {
			isMaximized: () => false, onMaximizeChange: () => {}, getSystemLocale: () => 'zh-CN',
			reportLanguage: () => {}, reportTheme: () => {}, getRequiredUpdate: () => null,
			onRequiredUpdate: () => () => {}, refreshAccount: async () => {},
			openFolderDialog: async () => null, onMenuCommand: () => () => {}, getAppVersion: () => '1.0.0',
		};
		Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async text => { window.__copiedText = text; } } });
	});
	await page.goto(base + '/', { waitUntil: 'commit' });
	await page.route('https://tora.ohfun.online/auth/me', route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ id: 'copy-test', username: 'copy-test' }) }));
	await page.route('https://tora.ohfun.online/billing/subscription', route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ subscription: null, windows: [], remainingPercent: 0, canUseAgent: false, plans: [], extraPurchasesEnabled: false }) }));
await page.route('https://tora.ohfun.online/tochat/quota', route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ enabled: false, models: [], chatRemaining: 150, remainingPercent: 100, canUseAgent: true, subscription: {planId:'plus',name:'Tora Plus',expiresAt:'2099-01-01T00:00:00Z'}, windows: [{key:'fiveHour',remainingPercent:100,resetAt:null}], workDailyRemaining: 1000000, workWeeklyRemaining: 10000000 }) }));
await page.route('https://tora.ohfun.online/models', route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ models: [] }) }));
	await page.route('https://tora.ohfun.online/polls/config', route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ enabled: true, entryVisible: true }) }));
	await page.route('https://tora.ohfun.online/account/messages', route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ messages: [], unread: 0 }) }));
	await page.route('https://tora.ohfun.online/account/events-ticket', route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ticket: 'copy-test-ticket' }) }));
	await page.routeWebSocket('wss://tora.ohfun.online/account/events*', socket => { socket.onMessage(message => { if (message === 'ping') socket.send('pong'); }); });
	await page.evaluate(serverUrl => {
		localStorage.setItem('server_url', serverUrl);
		localStorage.setItem('tora_auth_token', 'copy-test-token');
		localStorage.setItem('username', 'copy-test');
		localStorage.setItem('tora:first-run:intro:v1', '1');
		localStorage.setItem('tora:first-use-consent:v1', JSON.stringify({ terms: true, privacy: true, crossBorder: true }));
		localStorage.setItem('tora:first-run:tour:v1', '1');
	}, base);
	await page.goto(`${base}/chat/${agentId}/${sessionId}`, { waitUntil: 'domcontentloaded' });
	const user = page.locator('[data-role="user"]').filter({ hasText: userText }).first();
	const assistant = page.locator('[data-role="assistant"]').filter({ hasText: assistantText }).first();
	const unfinished = page.locator('[data-role="assistant"]').filter({ hasText: '尚未结束的半截回复' }).first();
	await assistant.waitFor({ state: 'visible' });
	const userCopy = user.getByRole('button', { name: '复制' });
	const assistantCopy = assistant.getByRole('button', { name: '复制' });
	assert.equal(await userCopy.count(), 1, '用户气泡应保留复制按钮');
	assert.equal(await assistantCopy.count(), 1, '旧 AI 消息即使缺 finished_reason 也应有复制按钮');
	assert.equal(await unfinished.getByRole('button', { name: '复制' }).count(), 1, '已保存的未完成回复在恢复时会被标记为中断');
	const copyOpacity = button => button.evaluate(element => Number(getComputedStyle(element.parentElement).opacity));
	await page.mouse.move(1, 1);
	assert.ok(await copyOpacity(assistantCopy) < 0.1, '鼠标未进入消息时复制按钮应隐藏');
	const rowBox = await assistant.boundingBox();
	const bubbleBox = await assistant.locator('[data-slot="bubble"]').first().boundingBox();
	assert.ok(rowBox && bubbleBox && rowBox.x + rowBox.width > bubbleBox.x + bubbleBox.width + 20);
	await page.mouse.move(rowBox.x + rowBox.width - 5, bubbleBox.y + bubbleBox.height / 2);
	assert.ok(await copyOpacity(assistantCopy) < 0.1, '消息行的空白处不应触发复制按钮');
	await assistant.locator('[data-slot="bubble"]').first().hover();
	await page.waitForFunction(() => {
		const button = [...document.querySelectorAll('[data-role="assistant"] button[aria-label="复制"]')][0];
		return button && Number(getComputedStyle(button.parentElement).opacity) > 0.9;
	});
	await assistantCopy.click();
	assert.equal(await page.evaluate(() => window.__copiedText), assistantText);
	await page.mouse.move(1, 1);
	await userCopy.focus();
	await page.waitForFunction(() => {
		const button = [...document.querySelectorAll('[data-role="user"] button[aria-label="复制"]')][0];
		return button && Number(getComputedStyle(button.parentElement).opacity) > 0.9;
	});
	await user.locator('[data-slot="bubble"]').first().hover();
	await userCopy.click();
	assert.equal(await page.evaluate(() => window.__copiedText), userText);
	assert.deepEqual(errors, [], `浏览器脚本错误：${errors.join(' | ')}`);
	console.log('用户复制、旧 AI 消息复制、仅气泡悬停显现与键盘聚焦：通过');
} finally {
	await browser.close();
	server.closeAllConnections?.();
	await Promise.race([new Promise(resolve => server.close(resolve)), new Promise(resolve => setTimeout(resolve, 1000))]);
	rmSync(testHome, { recursive: true, force: true });
}
