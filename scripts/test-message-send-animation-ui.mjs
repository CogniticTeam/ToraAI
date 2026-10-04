// 隔离会话：只让新发送的用户气泡入场，历史记录不重播；不调用模型服务。
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright-core';

const chrome = [process.env.TORA_CHROME_PATH, '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', '/usr/bin/chromium'].find(path => path && existsSync(path));
if (!chrome) throw new Error('找不到 Chrome/Chromium，请设置 TORA_CHROME_PATH');

const testHome = mkdtempSync(join(tmpdir(), 'tora-send-motion-'));
process.env.TORA_HOME = testHome;
const { startASAPIServer } = await import('../packages/core/src/asapi/server.js');
const { loadSessionRecord, saveSessionRecord } = await import('../packages/core/src/asapi/store.js');
const { userMsg } = await import('../packages/core/src/asapi/protocol.js');
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
	record.display = [userMsg('历史消息不应重播动画')];
	saveSessionRecord(record);

	const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, locale: 'zh-CN' });
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
	await page.route('https://tora.ohfun.online/auth/me', route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ id: 'motion-test', username: 'motion-test' }) }));
	await page.route('https://tora.ohfun.online/tochat/quota', route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ enabled: false, models: [], chatRemaining: 150, workDailyRemaining: 1000000, workWeeklyRemaining: 10000000 }) }));
await page.route('https://tora.ohfun.online/models', route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ models: [] }) }));
	await page.route('https://tora.ohfun.online/polls/config', route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ enabled: true, entryVisible: true }) }));
	await page.route('https://tora.ohfun.online/account/messages', route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ messages: [], unread: 0 }) }));
	await page.route('https://tora.ohfun.online/account/events-ticket', route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ticket: 'motion-test-ticket' }) }));
	await page.routeWebSocket('wss://tora.ohfun.online/account/events*', socket => { socket.onMessage(message => { if (message === 'ping') socket.send('pong'); }); });
	await page.route('**/chat/', route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ status: 'accepted', session_id: sessionId }) }));
	await page.evaluate(serverUrl => {
		localStorage.setItem('server_url', serverUrl);
		localStorage.setItem('tora_auth_token', 'motion-test-token');
		localStorage.setItem('username', 'motion-test');
		localStorage.setItem('tora:first-run:intro:v1', '1');
		localStorage.setItem('tora:first-use-consent:v1', JSON.stringify({ terms: true, privacy: true, crossBorder: true }));
		localStorage.setItem('tora:first-run:tour:v1', '1');
	}, base);
	await page.goto(`${base}/chat/${agentId}/${sessionId}`, { waitUntil: 'domcontentloaded' });
	await page.getByText('历史消息不应重播动画', { exact: true }).waitFor({ state: 'visible' });
	assert.equal(await page.locator('[data-send-entrance="true"]').count(), 0, '历史消息不应播放发送动效');

	await page.evaluate(() => {
		window.__sendMotionStart = null;
		new MutationObserver(() => {
			const element = document.querySelector('[data-send-entrance="true"]');
			if (element && !window.__sendMotionStart) window.__sendMotionStart = {
				style: element.getAttribute('style'), text: element.textContent,
				animations: element.getAnimations().map(animation => ({ playState: animation.playState, currentTime: animation.currentTime, keyframes: animation.effect?.getKeyframes() })),
				reduced: matchMedia('(prefers-reduced-motion: reduce)').matches,
			};
		}).observe(document.body, { childList: true, subtree: true });
	});
	await page.locator('#tour-chat-textarea').fill('发送动效测试');
	await page.locator('#tour-chat-textarea').press('Enter');
	const sent = page.locator('[data-send-entrance="true"]').filter({ hasText: '发送动效测试' }).first();
	await sent.waitFor({ state: 'visible' });
	await page.waitForFunction(() => window.__sendMotionStart !== null);
	const start = await page.evaluate(() => window.__sendMotionStart);
	const entrance = start.animations.find(animation => animation.keyframes?.[0]?.opacity === '0'
		&& /translateY\(24px\)/.test(animation.keyframes[0].transform));
	assert.ok(entrance && entrance.playState === 'running', '新发送气泡应播放透明度与上移动画');
	if (process.env.TORA_SEND_MOTION_SNAPSHOT_DIR) {
		await page.screenshot({ path: join(process.env.TORA_SEND_MOTION_SNAPSHOT_DIR, 'send-enter.png') });
	}
	await page.waitForTimeout(450);
	const end = await sent.evaluate(element => ({ opacity: getComputedStyle(element).opacity, transform: getComputedStyle(element).transform }));
	assert.equal(end.opacity, '1', '入场结束后气泡必须完全可见');
	if (process.env.TORA_SEND_MOTION_SNAPSHOT_DIR) {
		await page.screenshot({ path: join(process.env.TORA_SEND_MOTION_SNAPSHOT_DIR, 'send-settled.png') });
	}

	await page.goto(`${base}/chat/${agentId}`, { waitUntil: 'domcontentloaded' });
	await page.locator('#tour-chat-textarea').fill('新会话首次发送');
	await page.locator('#tour-chat-textarea').press('Enter');
	await page.locator('[data-send-entrance="true"]').filter({ hasText: '新会话首次发送' }).first().waitFor({ state: 'visible' });

	const createSession = async () => (await (await fetch(`${base}/sessions/`, {
		method: 'POST', headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ agent_id: agentId }),
	})).json()).session_id;
	await page.evaluate(() => localStorage.setItem('tora.motion.mode', 'off'));
	await page.goto(`${base}/chat/${agentId}/${await createSession()}`, { waitUntil: 'domcontentloaded' });
	await page.locator('#tour-chat-textarea').fill('关闭动画时的消息');
	await page.locator('#tour-chat-textarea').press('Enter');
	await page.getByText('关闭动画时的消息', { exact: true }).waitFor({ state: 'visible' });
	assert.equal(await page.locator('[data-send-entrance="true"]').count(), 0, '主题关闭动画后不得播放发送动效');

	await page.evaluate(() => localStorage.setItem('tora.motion.mode', 'standard'));
	await page.emulateMedia({ reducedMotion: 'reduce' });
	await page.goto(`${base}/chat/${agentId}/${await createSession()}`, { waitUntil: 'domcontentloaded' });
	await page.locator('#tour-chat-textarea').fill('系统减少动态效果');
	await page.locator('#tour-chat-textarea').press('Enter');
	await page.getByText('系统减少动态效果', { exact: true }).waitFor({ state: 'visible' });
	assert.equal(await page.locator('[data-send-entrance="true"]').count(), 0, '系统减少动态效果时不得播放发送动效');
	assert.deepEqual(errors, [], `浏览器脚本错误：${errors.join(' | ')}`);
	console.log('发送气泡：新旧会话入场、历史不重播、关闭与减少动态效果：通过');
} finally {
	await browser.close();
	server.closeAllConnections?.();
	await Promise.race([new Promise(resolve => server.close(resolve)), new Promise(resolve => setTimeout(resolve, 1000))]);
	rmSync(testHome, { recursive: true, force: true });
}
