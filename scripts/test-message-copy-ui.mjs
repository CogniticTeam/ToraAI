// 独立临时 ASAPI：验证旧会话 finished_reason 缺失时 AI 复制仍出现，流式半截回复不出现。
import { createRequire } from 'node:module';
import { strict as assert } from 'node:assert';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright-core');
const chrome = [process.env.COCODE_CHROME_PATH, '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', '/usr/bin/chromium'].find(path => path && existsSync(path));
if (!chrome) throw new Error('找不到 Chrome/Chromium，请设置 COCODE_CHROME_PATH');

const testHome = mkdtempSync(join(tmpdir(), 'cocode-message-copy-'));
process.env.COCODE_HOME = testHome;
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
		window.cocodeWindow = {
			isMaximized: () => false, onMaximizeChange: () => {}, getSystemLocale: () => 'zh-CN',
			reportLanguage: () => {}, reportTheme: () => {}, getRequiredUpdate: () => null,
			onRequiredUpdate: () => () => {}, refreshAccount: async () => {},
			openFolderDialog: async () => null, onMenuCommand: () => () => {}, getAppVersion: () => '1.0.0',
		};
		Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async text => { window.__copiedText = text; } } });
	});
	await page.goto(base + '/', { waitUntil: 'commit' });
	await page.route('https://cocode.ohfun.online/auth/me', route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ id: 'copy-test', username: 'copy-test' }) }));
	await page.route('https://cocode.ohfun.online/models', route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ models: [] }) }));
	await page.route('https://cocode.ohfun.online/polls/config', route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ enabled: true, entryVisible: true }) }));
	await page.route('https://cocode.ohfun.online/account/messages', route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ messages: [], unread: 0 }) }));
	await page.route('https://cocode.ohfun.online/account/events-ticket', route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ticket: 'copy-test-ticket' }) }));
	await page.routeWebSocket('wss://cocode.ohfun.online/account/events*', socket => { socket.onMessage(message => { if (message === 'ping') socket.send('pong'); }); });
	await page.evaluate(serverUrl => {
		localStorage.setItem('server_url', serverUrl);
		localStorage.setItem('cocode_auth_token', 'copy-test-token');
		localStorage.setItem('username', 'copy-test');
		localStorage.setItem('cocode:first-run:intro:v1', '1');
		localStorage.setItem('cocode:first-run:tour:v1', '1');
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
	assert.equal(await unfinished.getByRole('button', { name: '复制' }).count(), 0, '未完成回复不得复制半截文本');
	await assistant.hover();
	await page.waitForFunction(() => {
		const button = [...document.querySelectorAll('[data-role="assistant"] button[aria-label="复制"]')][0];
		return button && Number(getComputedStyle(button.parentElement).opacity) > 0.9;
	});
	await assistantCopy.click();
	assert.equal(await page.evaluate(() => window.__copiedText), assistantText);
	await user.hover();
	await userCopy.click();
	assert.equal(await page.evaluate(() => window.__copiedText), userText);
	assert.deepEqual(errors, [], `浏览器脚本错误：${errors.join(' | ')}`);
	console.log('用户复制、旧 AI 消息复制、悬停显现、未完成回复隐藏：通过');
} finally {
	await browser.close();
	server.closeAllConnections?.();
	await Promise.race([new Promise(resolve => server.close(resolve)), new Promise(resolve => setTimeout(resolve, 1000))]);
	rmSync(testHome, { recursive: true, force: true });
}
