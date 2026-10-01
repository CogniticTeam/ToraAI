// 隔离本地会话验证任务过程折叠与结语，不调用真实模型或修改用户数据。
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright-core';

const chrome = [process.env.TORA_CHROME_PATH, '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome'].find(path => path && existsSync(path));
if (!chrome) throw new Error('找不到 Chrome/Chromium');
const testHome = mkdtempSync(join(tmpdir(), 'tora-task-process-'));
process.env.TORA_HOME = testHome;
const { startASAPIServer } = await import('../packages/core/src/asapi/server.js');
const { loadSessionRecord, saveSessionRecord } = await import('../packages/core/src/asapi/store.js');
const { userMsg, assistantMsgShell } = await import('../packages/core/src/asapi/protocol.js');
const server = await startASAPIServer({ port: 0 });
const base = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ headless: true, executablePath: chrome, args: ['--no-sandbox'] });

try {
	const agentId = (await (await fetch(`${base}/agent/`)).json()).agents[0].id;
	const { session_id: sessionId } = await (await fetch(`${base}/sessions/`, {
		method: 'POST', headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ agent_id: agentId }),
	})).json();
	const record = loadSessionRecord(sessionId);
	const start = '2026-09-27T12:00:00.000Z';
	const end = '2026-09-27T12:02:04.000Z';
	const text = (id, value) => ({ id, type: 'text', text: value, created_at: start, finished_at: end });
	const reply = assistantMsgShell('task-reply');
	reply.created_at = start;
	reply.finished_at = end;
	reply.content = [
		{ id: 'thinking', type: 'thinking', thinking: '分析文件结构', created_at: start, finished_at: end },
		text('progress', '我先检查现有实现。'),
		{ id: 'edit-call', type: 'tool_call', name: 'Edit', input: JSON.stringify({ path: 'src/example.ts' }), state: 'finished', created_at: start, finished_at: end },
		{ id: 'edit-call', type: 'tool_result', name: 'Edit', output: [text('edit-result', '已修改')], state: 'success', metadata: { diff: '@@ -1 +1 @@\n-old\n+new' }, created_at: start, finished_at: end },
		text('conclusion', '已完成修复，并通过构建检查。'),
	];
	const noConclusion = assistantMsgShell('task-no-conclusion');
	noConclusion.created_at = start;
	noConclusion.finished_at = end;
	noConclusion.content = [
		text('progress-only', '我开始检查。'),
		{ id: 'read-call', type: 'tool_call', name: 'Read', input: JSON.stringify({ path: 'src/example.ts' }), state: 'finished', created_at: start, finished_at: end },
	];
	const running = assistantMsgShell('task-running');
	running.created_at = start;
	running.content = [
		text('running-progress', '正在检查运行中的任务。'),
		{ id: 'running-thinking', type: 'thinking', thinking: '还在分析', created_at: start, finished_at: null },
	];
	const blocked = assistantMsgShell('task-blocked');
	blocked.finished_at = end;
	blocked.finished_reason = 'error';
	blocked.error = { type: 'blocked', message: '测试规则阻止' };
	record.display = [userMsg('修复示例'), reply, userMsg('再检查一次'), noConclusion, userMsg('继续'), running, userMsg('受规则限制'), blocked];
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
		Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async value => { window.__copiedText = value; } } });
	});
	await page.goto(base + '/', { waitUntil: 'commit' });
	for (const path of ['/auth/me', '/models', '/polls/config', '/account/messages', '/account/events-ticket']) {
		const value = path === '/auth/me' ? { id: 'task-test', username: 'task-test' }
			: path === '/models' ? { models: [] }
			: path === '/polls/config' ? { enabled: true, entryVisible: true }
			: path === '/account/messages' ? { messages: [], unread: 0 }
			: { ticket: 'task-test-ticket' };
		await page.route(`https://tora.ohfun.online${path}`, route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(value) }));
	}
	await page.routeWebSocket('wss://tora.ohfun.online/account/events*', socket => { socket.onMessage(message => { if (message === 'ping') socket.send('pong'); }); });
	await page.evaluate(serverUrl => {
		localStorage.setItem('server_url', serverUrl);
		localStorage.setItem('tora_auth_token', 'task-test-token');
		localStorage.setItem('username', 'task-test');
		localStorage.setItem('tora.theme', 'light');
		localStorage.setItem('tora:first-run:intro:v1', '1');
		localStorage.setItem('tora:first-run:tour:v1', '1');
		localStorage.setItem('tora:first-use-consent:v1', JSON.stringify({ terms: true, privacy: true, crossBorder: true }));
	}, base);
	await page.goto(`${base}/chat/${agentId}/${sessionId}`, { waitUntil: 'domcontentloaded' });
	const assistant = page.locator('[data-role="assistant"]').filter({ hasText: '已完成修复' }).first();
	await assistant.waitFor({ state: 'visible' });
	const process = assistant.locator('[data-task-process]');
	assert.equal(await process.count(), 1);
	assert.equal(await assistant.getByText('已完成修复，并通过构建检查。').isVisible(), true, '结语始终可见');
	assert.equal(await assistant.getByText('我先检查现有实现。').count(), 0, '历史过程默认折叠');
	assert.equal(await assistant.getByText('1 个文件已更改').isVisible(), true, '改动摘要保留在过程外');
	await process.getByRole('button', { name: '用时 2分钟4秒' }).click();
	await assistant.getByText('我先检查现有实现。').waitFor({ state: 'visible' });
	assert.equal(await assistant.getByText('已完成修复，并通过构建检查。').isVisible(), true, '展开过程不隐藏结语');
	await assistant.hover();
	await assistant.getByRole('button', { name: '复制' }).click();
	assert.equal(await page.evaluate(() => window.__copiedText), '已完成修复，并通过构建检查。', '复制只取结语');
	const missing = page.locator('[data-role="assistant"]').filter({ hasText: '模型未给出结语' }).first();
	assert.equal(await missing.locator('[data-task-conclusion-missing]').isVisible(), true, '旧记录缺少结语时明确说明');
	const active = page.locator('[data-role="assistant"]').filter({ hasText: '正在检查运行中的任务。' }).first();
	assert.equal(await active.getByText('正在检查运行中的任务。').isVisible(), true, '进行中默认展开过程');
	await active.locator('[data-task-process]').getByRole('button', { name: /已用时/ }).click();
	assert.equal(await active.getByText('正在检查运行中的任务。').count(), 0, '进行中也允许手动折叠');
	const denied = page.locator('[data-role="assistant"]').filter({ hasText: '本轮被规则阻止' }).first();
	assert.equal(await denied.getByText('本轮被规则阻止').isVisible(), true, '规则拒绝不能显示为正常完成');
	assert.equal(await denied.getByText('测试规则阻止').isVisible(), true, '拒绝原因必须可见');
	await page.screenshot({ path: '/tmp/tora-task-process-light.png' });
	await page.evaluate(() => localStorage.setItem('tora.theme', 'dark'));
	await page.reload({ waitUntil: 'domcontentloaded' });
	await page.locator('[data-role="assistant"]').filter({ hasText: '已完成修复' }).first().waitFor({ state: 'visible' });
	await page.screenshot({ path: '/tmp/tora-task-process-dark.png' });
	assert.deepEqual(errors, []);
	console.log('任务过程折叠、结语、改动摘要、复制与缺失结语兜底：通过');
} finally {
	await browser.close();
	server.closeAllConnections?.();
	await Promise.race([new Promise(resolve => server.close(resolve)), new Promise(resolve => setTimeout(resolve, 1000))]);
	rmSync(testHome, { recursive: true, force: true });
}
