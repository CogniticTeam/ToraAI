// 独立临时 ASAPI + headless 浏览器：验证终端面板从空会话打开、键入、回车与退出。
import { createRequire } from 'node:module';
import { strict as assert } from 'node:assert';
import { existsSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright-core');
const chrome = [process.env.COCODE_CHROME_PATH, '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', '/usr/bin/chromium'].find(path => path && existsSync(path));
if (!chrome) throw new Error('找不到 Chrome/Chromium，请设置 COCODE_CHROME_PATH');

const testHome = mkdtempSync(join(tmpdir(), 'cocode-terminal-ui-'));
const projectPath = realpathSync(testHome);
process.env.COCODE_HOME = testHome;
const { startASAPIServer } = await import('../packages/core/src/asapi/server.js');
const server = await startASAPIServer({ port: 0 });
const base = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ headless: true, executablePath: chrome, args: ['--no-sandbox'] });

try {
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
	});
	await page.goto(base + '/', { waitUntil: 'commit' });
	await page.route('https://cocode.ohfun.online/auth/me', route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ id: 'terminal-test', username: 'terminal-test' }) }));
	await page.route('https://cocode.ohfun.online/models', route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ models: [] }) }));
	await page.route('https://cocode.ohfun.online/polls/config', route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ enabled: true, entryVisible: true }) }));
	await page.route('https://cocode.ohfun.online/account/messages', route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ messages: [], unread: 0 }) }));
	await page.route('https://cocode.ohfun.online/account/events-ticket', route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ticket: 'terminal-test-ticket' }) }));
	await page.routeWebSocket('wss://cocode.ohfun.online/account/events*', socket => { socket.onMessage(message => { if (message === 'ping') socket.send('pong'); }); });
	await page.evaluate(serverUrl => {
		localStorage.setItem('server_url', serverUrl);
		localStorage.setItem('cocode_auth_token', 'terminal-test-token');
		localStorage.setItem('username', 'terminal-test');
		localStorage.setItem('cocode:first-run:intro:v1', '1');
		localStorage.setItem('cocode:first-run:tour:v1', '1');
	}, base);
	await page.reload({ waitUntil: 'domcontentloaded' });
	await page.locator('#tour-llm-select').first().waitFor({ state: 'visible' });
	await page.locator('button:has(svg.lucide-panel-right)').first().click();
	await page.getByRole('menuitemcheckbox', { name: /终端|Terminal/ }).click();
	await page.keyboard.press('Escape');
	const terminal = page.locator('.xterm').first();
	await terminal.waitFor({ state: 'visible' });
	await page.getByText(homedir(), { exact: true }).waitFor({ state: 'visible' });
	const input = terminal.locator('.xterm-helper-textarea');
	await input.focus();
	await page.keyboard.type('echo $((40+2))');
	await page.waitForFunction(() => document.querySelector('.xterm-rows')?.textContent?.includes('echo $((40+2))'));
	await page.keyboard.press('Enter');
	await page.waitForFunction(() => [...document.querySelectorAll('.xterm-rows > div')].some(row => row.textContent?.trim() === '42'));
	await page.keyboard.type('echo 9x');
	await page.keyboard.press('Backspace');
	await page.keyboard.type('8');
	await page.keyboard.press('Enter');
	await page.waitForFunction(() => [...document.querySelectorAll('.xterm-rows > div')].some(row => row.textContent?.trim() === '98'));
	await page.keyboard.press('ArrowUp');
	await page.keyboard.press('Enter');
	await page.waitForFunction(() => [...document.querySelectorAll('.xterm-rows > div')].filter(row => row.textContent?.trim() === '98').length >= 2);
	await input.focus();
	await page.keyboard.type('echo INTERRUPT_READY; sleep 10');
	await page.keyboard.press('Enter');
	await page.waitForFunction(() => [...document.querySelectorAll('.xterm-rows > div')].some(row => row.textContent?.trim() === 'INTERRUPT_READY'));
	await page.waitForTimeout(200);
	const interrupted = page.waitForRequest(request => /\/terminal\/[\w-]+\/interrupt$/.test(new URL(request.url()).pathname) && request.method() === 'POST');
	const interruptResponse = page.waitForResponse(response => /\/terminal\/[\w-]+\/interrupt$/.test(new URL(response.url()).pathname));
	await page.keyboard.press('Control+C');
	await interrupted;
	const interruptStatus = (await interruptResponse).status();
	await page.keyboard.type('echo 73');
	await page.keyboard.press('Enter');
	try {
		await page.waitForFunction(() => [...document.querySelectorAll('.xterm-rows > div')].some(row => row.textContent?.trim() === '73'), undefined, { timeout: 5000 });
	} catch {
		throw new Error(`Ctrl+C 后 shell 未继续工作：interrupt HTTP ${interruptStatus}；终端内容 ${JSON.stringify(await page.locator('.xterm-rows').innerText())}`);
	}
	assert.deepEqual(errors, [], `浏览器脚本错误：${errors.join(' | ')}`);
	const lightBackground = await terminal.locator('.xterm-viewport').evaluate(element => getComputedStyle(element).backgroundColor);
	assert.notEqual(lightBackground, 'rgb(0, 0, 0)', '浅色模式下终端不应是黑底深字');
	await page.screenshot({ path: '/tmp/cocode-terminal-working.png' });
	await page.evaluate(() => document.documentElement.classList.add('dark'));
	await page.waitForFunction(previous => {
		const viewport = document.querySelector('.xterm-viewport');
		return viewport && getComputedStyle(viewport).backgroundColor !== previous;
	}, lightBackground);
	const darkForeground = await terminal.locator('.xterm-rows span').first().evaluate(element => getComputedStyle(element).color);
	const lightForeground = await page.locator('.cocode-terminal').evaluate(element => {
		const original = document.documentElement.classList.contains('dark');
		document.documentElement.classList.remove('dark');
		const color = getComputedStyle(element).color;
		if (original) document.documentElement.classList.add('dark');
		return color;
	});
	assert.notEqual(darkForeground, lightForeground, '切换深色主题后终端文字应切为浅色');
	await page.screenshot({ path: '/tmp/cocode-terminal-dark.png' });
	await page.evaluate(() => document.documentElement.classList.remove('dark'));
	const killed = page.waitForRequest(request => /\/terminal\/[\w-]+\/kill$/.test(new URL(request.url()).pathname) && request.method() === 'POST');
	await page.locator('button:has(svg.lucide-panel-right)').first().click();
	await page.getByRole('menuitemcheckbox', { name: /终端|Terminal/ }).click();
	await page.keyboard.press('Escape');
	await killed;
	const agentId = (await (await fetch(`${base}/agent/`)).json()).agents[0].id;
	const created = await (await fetch(`${base}/sessions/`, {
		method: 'POST', headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ agent_id: agentId, cwd: testHome }),
	})).json();
	await page.goto(`${base}/chat/${agentId}/${created.session_id}`, { waitUntil: 'domcontentloaded' });
	await page.locator('#tour-llm-select').first().waitFor({ state: 'visible' });
	await page.locator('button:has(svg.lucide-panel-right)').first().click();
	await page.getByRole('menuitemcheckbox', { name: /终端|Terminal/ }).click();
	await page.keyboard.press('Escape');
	await page.getByText(projectPath, { exact: true }).waitFor({ state: 'visible' });
	const projectInput = page.locator('.xterm-helper-textarea').first();
	await projectInput.focus();
	await page.keyboard.type('basename "$PWD"');
	await page.keyboard.press('Enter');
	await page.waitForFunction(folderName => [...document.querySelectorAll('.xterm-rows > div')].some(row => row.textContent?.trim() === folderName), testHome.split('/').at(-1));
	const projectKilled = page.waitForRequest(request => /\/terminal\/[\w-]+\/kill$/.test(new URL(request.url()).pathname) && request.method() === 'POST');
	await page.locator('button:has(svg.lucide-panel-right)').first().click();
	await page.getByRole('menuitemcheckbox', { name: /终端|Terminal/ }).click();
	await page.keyboard.press('Escape');
	await projectKilled;
	console.log('终端空会话打开、主目录、输入回显、回车执行、退格与历史、Ctrl+C、主题切换、项目目录、关闭清理：通过');
} finally {
	await browser.close();
	server.closeAllConnections?.();
	await Promise.race([new Promise(resolve => server.close(resolve)), new Promise(resolve => setTimeout(resolve, 1000))]);
	rmSync(testHome, { recursive: true, force: true });
}
