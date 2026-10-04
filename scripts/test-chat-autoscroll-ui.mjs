// 隔离会话验证聊天区贴底跟随、手动上滑暂停和回到底部恢复；不调用真实模型。
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright-core';

const chrome = [process.env.TORA_CHROME_PATH, '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome'].find(path => path && existsSync(path));
if (!chrome) throw new Error('找不到 Chrome/Chromium');
const testHome = mkdtempSync(join(tmpdir(), 'tora-chat-autoscroll-'));
process.env.TORA_HOME = testHome;
const { startASAPIServer } = await import('../packages/core/src/asapi/server.js');
const { loadSessionRecord, saveSessionRecord } = await import('../packages/core/src/asapi/store.js');
const { userMsg, assistantMsgShell } = await import('../packages/core/src/asapi/protocol.js');
const { E } = await import('../packages/core/src/asapi/protocol.js');
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
	const now = new Date().toISOString();
	record.display = Array.from({ length: 32 }, (_, index) => {
		if (index % 2 === 0) return userMsg(`第 ${index + 1} 条问题：${'内容 '.repeat(24)}`);
		const reply = assistantMsgShell(`reply-${index}`);
		reply.content = [{ id: `text-${index}`, type: 'text', text: `第 ${index + 1} 条回答：${'正文 '.repeat(48)}`, created_at: now, finished_at: now }];
		reply.finished_at = now;
		return reply;
	});
	saveSessionRecord(record);

	const page = await browser.newPage({ viewport: { width: 1280, height: 700 }, locale: 'zh-CN' });
	const errors = [];
	page.on('pageerror', error => errors.push(error.message));
	await page.addInitScript(() => {
		window.toraWindow = {
			isMaximized: () => false, onMaximizeChange: () => {}, getSystemLocale: () => 'zh-CN',
			reportLanguage: () => {}, reportTheme: () => {}, getRequiredUpdate: () => null,
			onRequiredUpdate: () => () => {}, refreshAccount: async () => {},
			openFolderDialog: async () => null, onMenuCommand: () => () => {}, getAppVersion: () => '1.0.0',
		};
	});
	await page.goto(base + '/', { waitUntil: 'commit' });
	await page.route('https://tora.ohfun.online/auth/me', route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ id: 'scroll-test', username: 'scroll-test' }) }));
	await page.route('https://tora.ohfun.online/billing/subscription', route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ subscription: null, windows: [], remainingPercent: 0, canUseAgent: false, plans: [], extraPurchasesEnabled: false }) }));
await page.route('https://tora.ohfun.online/tochat/quota', route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ enabled: false, models: [], chatRemaining: 150, remainingPercent: 100, canUseAgent: true, subscription: {planId:'plus',name:'Tora Plus',expiresAt:'2099-01-01T00:00:00Z'}, windows: [{key:'fiveHour',remainingPercent:100,resetAt:null}], workDailyRemaining: 1000000, workWeeklyRemaining: 10000000 }) }));
await page.route('https://tora.ohfun.online/models', route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ models: [] }) }));
	await page.route('https://tora.ohfun.online/polls/config', route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ enabled: true, entryVisible: true }) }));
	await page.route('https://tora.ohfun.online/account/messages', route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ messages: [], unread: 0 }) }));
	await page.route('https://tora.ohfun.online/account/events-ticket', route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ticket: 'scroll-test-ticket' }) }));
	await page.routeWebSocket('wss://tora.ohfun.online/account/events*', socket => { socket.onMessage(message => { if (message === 'ping') socket.send('pong'); }); });
	await page.evaluate(serverUrl => {
		localStorage.setItem('server_url', serverUrl);
		localStorage.setItem('tora_auth_token', 'scroll-test-token');
		localStorage.setItem('username', 'scroll-test');
		localStorage.setItem('tora:first-run:intro:v1', '1');
		localStorage.setItem('tora:first-run:tour:v1', '1');
		localStorage.setItem('tora:first-use-consent:v1', JSON.stringify({ terms: true, privacy: true, crossBorder: true }));
	}, base);
	await page.goto(`${base}/chat/${agentId}/${sessionId}`, { waitUntil: 'domcontentloaded' });
	const viewport = page.locator('[data-slot="message-scroller-viewport"]');
	await viewport.waitFor({ state: 'visible' });
	const distance = () => viewport.evaluate(element => element.scrollHeight - element.clientHeight - element.scrollTop);
	await page.waitForFunction(() => {
		const element = document.querySelector('[data-slot="message-scroller-viewport"]');
		return element && element.scrollHeight - element.clientHeight - element.scrollTop < 50;
	});
	await viewport.focus();
	const focus = await viewport.evaluate(element => ({
		tabIndex: element.tabIndex,
		outline: getComputedStyle(element).outlineStyle,
		shadow: getComputedStyle(element).boxShadow,
	}));
	assert.equal(focus.tabIndex, 0, '消息区仍应支持键盘聚焦与滚动');
	assert.equal(focus.outline, 'none', '聚焦消息区不应出现整圈白色方框');
	assert.equal(focus.shadow, 'none', '聚焦消息区不应出现左侧焦点线或其他框');
	await page.screenshot({ path: '/tmp/tora-chat-focus-after.png' });

	const grow = height => page.evaluate(height => {
		const content = document.querySelector('[data-slot="message-scroller-content"]');
		const block = document.createElement('div');
		block.style.height = `${height}px`;
		block.style.flexShrink = '0';
		content.insertBefore(block, content.querySelector('[data-message-scroller-spacer]'));
	}, height);
	await grow(320);
	await page.waitForTimeout(100);
	assert.ok(await distance() < 50, '新内容变高后应自动跟随到底部');

	await viewport.hover();
	await page.mouse.wheel(0, -600);
	await page.waitForFunction(() => {
		const element = document.querySelector('[data-slot="message-scroller-viewport"]');
		return element && element.scrollHeight - element.clientHeight - element.scrollTop > 250;
	});
	await page.waitForTimeout(250); // 等待触控板/滚轮的惯性滚动结束，再记录阅读位置。
	const pausedTop = await viewport.evaluate(element => element.scrollTop);
	await grow(360);
	await page.waitForTimeout(100);
	const afterPause = await viewport.evaluate(element => element.scrollTop);
	assert.ok(Math.abs(afterPause - pausedTop) < 5, `手动上滑后新内容不能拉走阅读位置 (${pausedTop} -> ${afterPause})`);

	await page.getByRole('button', { name: 'Scroll to end' }).click();
	await page.waitForFunction(() => {
		const element = document.querySelector('[data-slot="message-scroller-viewport"]');
		return element && element.scrollHeight - element.clientHeight - element.scrollTop < 50;
	});
	await grow(240);
	await page.waitForTimeout(100);
	assert.ok(await distance() < 50, '回到底部后应恢复自动跟随');

	// 首条 SSE 在块开始后断开；第二条必须携带游标并把正文接到同一条回复。
	const replyId = 'reply-reconnect-test';
	const blockId = 'block-reconnect-test';
	const streamRequests = [];
	const frame = (status, events) => `: connected\n\n: stream-status ${JSON.stringify(status)}\n\n${events.map(([seq, event]) => `id: mock-stream:${seq}\ndata: ${JSON.stringify(event)}\n\n`).join('')}`;
	await page.route(/\/sessions\/[^/]+\/stream/, async route => {
		const cursor = new URL(route.request().url()).searchParams.get('after_cursor');
		streamRequests.push(cursor);
		if (streamRequests.length === 1) {
			await route.fulfill({ status: 200, contentType: 'text/event-stream', body: frame({ mode: 'initial', streamId: 'mock-stream' }, [
				[1, E.replyStart(sessionId, replyId)], [2, E.textBlockStart(replyId, blockId)]
			]) });
		} else if (streamRequests.length === 2) {
			await route.fulfill({ status: 200, contentType: 'text/event-stream', body: frame({ mode: 'resume', streamId: 'mock-stream' }, [
				[3, E.textBlockDelta(replyId, blockId, '断线续传可见')],
				[4, E.textBlockEnd(replyId, blockId)], [5, E.replyEnd(sessionId, replyId, 'completed')]
			]) });
		} else {
			await new Promise(resolve => setTimeout(resolve, 3000));
			await route.abort().catch(() => {});
		}
	});
	await page.reload({ waitUntil: 'domcontentloaded' });
	await page.getByText('断线续传可见').waitFor({ state: 'visible' });
	assert.equal(streamRequests[0], null);
	assert.equal(streamRequests[1], 'mock-stream:2', '重连请求必须携带最后收到的事件游标');
	assert.deepEqual(errors, []);
	console.log('聊天自动滚动与 SSE：贴底跟随、上滑暂停、恢复、游标重连均通过');
} finally {
	await browser.close();
	server.closeAllConnections?.();
	await Promise.race([new Promise(resolve => server.close(resolve)), new Promise(resolve => setTimeout(resolve, 1000))]);
	rmSync(testHome, { recursive: true, force: true });
}
