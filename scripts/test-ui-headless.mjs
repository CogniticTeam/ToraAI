// headless 浏览器冒烟测试：加载 CoCode 前端，预置 localStorage，验证聊天页渲染
// 运行：node scripts/test-ui-headless.mjs
import { createRequire } from 'node:module';
import { strict as assert } from 'node:assert';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Playwright 是项目开发依赖；保留环境变量只为诊断其它安装位置时覆盖。
const require = process.env.COCODE_PLAYWRIGHT_REQUIRE
  ? createRequire(process.env.COCODE_PLAYWRIGHT_REQUIRE)
  : createRequire(import.meta.url);
const { chromium } = require('playwright-core');

const chromeCandidates = [
  process.env.COCODE_CHROME_PATH,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
].filter(Boolean);
const CHROME = chromeCandidates.find((p) => existsSync(p));
const shots = [];
const out = [];

async function main() {
  if (!CHROME) throw new Error(`找不到可执行的 Chrome/Chromium；可用 COCODE_CHROME_PATH 指定。已检查：${chromeCandidates.join('、')}`);
  // 默认自起一套 ASAPI + 临时数据目录：UI 冒烟不能污染用户的 agents、会话、凭证。
  // COCODE_UI_BASE 仅用于明确指定已有环境时的调试，不会尝试停止那个服务。
  let srv = null;
  let testHome = null;
  let base = String(process.env.COCODE_UI_BASE || '').replace(/\/$/, '');
  if (!base) {
    testHome = mkdtempSync(join(tmpdir(), 'cocode-ui-smoke-'));
    process.env.COCODE_HOME = testHome;
    // 给本脚本自建的 ASAPI 一条可预测的流式模型通道。浏览器仍通过真实
    // HTTP/SSE 调用本地 server；只有 server → 模型的外部网络边被 mock，
    // 所以能验证发送、SSE、消息气泡及 Markdown 懒加载而不消耗用户额度。
    const originalFetch = globalThis.fetch;
    const mockModelBase = 'http://cocode-ui-smoke-model.invalid/v1';
    process.env.COCODE_BASE_URL = mockModelBase;
    process.env.COCODE_API_KEY = 'ui-smoke-key';
    globalThis.fetch = async (url, init) => {
      if (String(url).startsWith(mockModelBase)) {
        const body = JSON.stringify({ choices: [{ delta: { content: '**渲染成功**' } }] });
        return new Response(`data: ${body}\n\ndata: [DONE]\n\n`, {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        });
      }
      return originalFetch(url, init);
    };
    const { startASAPIServer } = await import('../packages/core/src/asapi/server.js');
    srv = await startASAPIServer({ port: 0 });
    base = `http://127.0.0.1:${srv.address().port}`;
  }

  const browser = await chromium.launch({
    headless: true,
    executablePath: CHROME,
    args: ['--no-sandbox', '--disable-gpu']
  });
  try {
    // 固定为中文系统环境，验证首次启动确实从 navigator 读取，而不是写死语言。
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, locale: 'zh-CN' });
    const logs = [];
    const startupRequests = [];
    let collectStartupRequests = false;
    page.on('console', (m) => { if (m.type() === 'error') logs.push(m.text().slice(0, 200)); });
    page.on('pageerror', (e) => logs.push('PAGEERROR: ' + String(e).slice(0, 200)));
    page.on('request', (request) => {
      if (!collectStartupRequests || !request.url().startsWith(base)) return;
      startupRequests.push(new URL(request.url()).pathname);
    });
    page.on('response', (response) => {
      if (response.status() >= 400) logs.push(`HTTP ${response.status()} ${response.url()}`);
    });

    // 1. setup 页已移除，直接进主应用；首次注入 localStorage 再 reload
    await page.goto(base + '/', { waitUntil: 'commit', timeout: 10000 });
    // 登录墙属于云端身份服务，不能让本地 UI smoke 依赖真实账号、Turnstile 或网络。
    // 只在这一个浏览器页面把 /auth/me 替换为固定成功响应；生产代码没有任何绕过。
    await page.route('https://cocode.ohfun.online/auth/me', (route) => route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ id: 'ui-smoke', username: 'ui-smoke' })
    }));
    await page.route('https://cocode.ohfun.online/models', (route) => route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ models: [] })
    }));
    await page.route('https://cocode.ohfun.online/polls/config', route => route.fulfill({
      status: 200, contentType: 'application/json', body: JSON.stringify({ enabled: true, entryVisible: true }),
    }));
    await page.route('https://cocode.ohfun.online/account/messages', route => route.fulfill({
      status: 200, contentType: 'application/json', body: JSON.stringify({ messages: [], unread: 0, nextOffset: null }),
    }));
    await page.route('https://cocode.ohfun.online/account/events-ticket', route => route.fulfill({
      status: 200, contentType: 'application/json', body: JSON.stringify({ ticket: 'ui-smoke-ticket' }),
    }));
    await page.routeWebSocket('wss://cocode.ohfun.online/account/events*', socket => {
      socket.send(JSON.stringify({ type: 'ready' }));
      socket.onMessage(message => { if (message === 'ping') socket.send('pong'); });
    });
    await page.evaluate((serverUrl) => {
      localStorage.setItem('server_url', serverUrl);
      localStorage.setItem('username', 'ui-smoke');
      localStorage.setItem('cocode_auth_token', 'ui-smoke-token');
      localStorage.removeItem('cocode_language_preference');
      localStorage.removeItem('i18nextLng');
    }, base);
    collectStartupRequests = true;
    // 账号事件与轮询会持续联网；等待真实 UI 元素，不以 networkidle 判定首屏完成。
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 15000 });
    try {
      await page.waitForSelector('textarea', { timeout: 15000 });
    } catch (e) {
      await page.screenshot({ path: '/tmp/cocode-shot-ui-failure.png' }).catch(() => {});
      const body = await page.locator('body').innerText().catch(() => '(无法读取页面正文)');
      throw new Error(`${e.message}\n页面正文：${body.slice(0, 1200)}\n浏览器错误：${logs.slice(0, 5).join(' | ') || '(无)'}`);
    }
    await page.waitForTimeout(600);
    collectStartupRequests = false;
    const startupCounts = new Map();
    for (const path of startupRequests) startupCounts.set(path, (startupCounts.get(path) || 0) + 1);
    const sharedStartupPaths = ['/agent/', '/sessions/', '/skill', '/knowledge_bases/'];
    for (const path of sharedStartupPaths) {
      assert.ok((startupCounts.get(path) || 0) <= 1, `首屏重复请求 ${path}: ${startupCounts.get(path)}`);
    }
    assert.equal(startupCounts.get('/knowledge_bases/middleware/parameters_schema') || 0, 0,
      '知识库面板关闭时不应读取参数 schema');
    const sharedRequestSummary = sharedStartupPaths
      .map((path) => `${path}=${startupCounts.get(path) || 0}`)
      .join('，');
    out.push(`首屏共享数据请求去重: true（${sharedRequestSummary}；本地请求 ${startupRequests.length} 个）`);
    assert.equal(await page.evaluate(() => document.documentElement.lang), 'zh',
      '无用户偏好时应根据中文系统语言首次显示中文');
    out.push('首次语言跟随系统: true（zh-CN → zh）');

    // 用户主动切换后写入独立偏好键；刷新后不得再被系统语言覆盖。
    await page.getByRole('button', { name: /ui-smoke/i }).first().click({ timeout: 5000 });
    await page.getByText(/^Switch to English$/).first().click({ timeout: 5000 });
    assert.equal(await page.evaluate(() => localStorage.getItem('cocode_language_preference')), 'en',
      '手动切换应持久化明确语言偏好');
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 15000 });
    await page.waitForSelector('textarea', { timeout: 15000 });
    assert.equal(await page.evaluate(() => document.documentElement.lang), 'en',
      '手动语言偏好应在刷新后覆盖系统语言');
    out.push('手动语言偏好持久化: true（zh-CN 系统保持 en）');
    await page.screenshot({ path: '/tmp/cocode-shot-1-home.png' });
    shots.push('主应用');
    await page.screenshot({ path: '/tmp/cocode-shot-2-chat.png' });
    shots.push('聊天主页');

    // 3. 当前主任务页的关键可交互入口（不再假设旧版侧栏有 Agent/设置按钮）。
    const pageText = await page.locator('body').innerText();
    const hasTaskShell = /与CoCode工作和编程|Work and Code with CoCode/i.test(pageText);
    const hasWorkspacePicker = /选择文件夹|Select a folder/i.test(pageText);
    assert.ok(hasTaskShell, '主任务页标题未渲染');
    assert.ok(hasWorkspacePicker, '工作目录选择入口未渲染');
    out.push(`主任务页标题渲染: ${hasTaskShell}`);
    out.push(`工作目录选择入口渲染: ${hasWorkspacePicker}`);

    // 4. 点击新任务导航；它是当前产品替代旧版「新会话」的入口。
    const newTask = page.getByText(/^(新任务|New task)$/i).first();
    await newTask.click({ timeout: 5000 });
    const clicked = true;
    await page.waitForTimeout(500);
    await page.screenshot({ path: '/tmp/cocode-shot-3-newsession.png' });
    shots.push('新任务导航后');
    out.push(`点击新任务导航: ${clicked}`);

    // 5. 输入框是否渲染
    const hasInput = await page.evaluate(() => !!document.querySelector('textarea'));
    out.push(`消息输入框渲染: ${hasInput}`);

    assert.ok(hasInput, '消息输入框未渲染');

    if (srv) {
      // 空会话先选交付模式：第一条消息自动创建会话时必须带上这两个值。
      await page.locator('button:has(svg.lucide-panel-right)').first().click({ timeout: 5000 });
      await page.getByRole('menuitemcheckbox', { name: /Verifiable delivery/i }).click({ timeout: 5000 });
      await page.keyboard.press('Escape');
      await page.getByRole('switch', { name: 'Enable verifiable delivery mode' }).click({ timeout: 5000 });
      await page.locator('#delivery-criteria').fill('Initial acceptance criterion');
      await page.getByRole('button', { name: 'Save criteria' }).click({ timeout: 5000 });
      await page.locator('button:has(svg.lucide-panel-right)').first().click({ timeout: 5000 });
      await page.getByRole('menuitemcheckbox', { name: /Verifiable delivery/i }).click({ timeout: 5000 });
      await page.keyboard.press('Escape');
    }

    // 6. 真正走一次浏览器 → 本地 ASAPI → mock SSE 模型 → 浏览器的闭环。
    // 仅在脚本自建临时服务时发送：COCODE_UI_BASE 是人工调试已有环境的逃生口，
    // 不能往那里写入测试会话或消耗模型额度。
    if (srv) {
      const input = page.locator('textarea').first();
      await input.fill('请用 Markdown 回复渲染成功');
      await input.press('Enter');
      const assistantReply = page.locator('[data-role="assistant"]').filter({ hasText: '渲染成功' }).last();
      await assistantReply.waitFor({ timeout: 15000 });
      const markdownChunkLoaded = await page.evaluate(() =>
        performance.getEntriesByType('resource').some((entry) => /\/assets\/markdown-[^/]+\.js(?:\?|$)/.test(entry.name)),
      );
      assert.ok(markdownChunkLoaded, '回复后未加载 Markdown 按需块');
      out.push('流式助手回复与 Markdown 按需渲染: true');

      // 新面板必须能通过真实菜单打开；交付报告要在本轮运行结束后可读取。
      const sessionForReport = (await (await fetch(`${base}/sessions/`)).json()).sessions[0]?.session?.id;
      assert.ok(sessionForReport, '未找到刚创建的会话');
      const firstSession = await (await fetch(`${base}/sessions/${sessionForReport}`)).json();
      assert.equal(firstSession.session.state.delivery_mode, true, '空会话预选交付模式应随首次消息生效');
      assert.equal(firstSession.session.state.delivery_criteria, 'Initial acceptance criterion');
      out.push('首次消息前预设交付模式随新会话生效: true');
      await page.waitForFunction(async ({ baseUrl, sid }) => {
        const response = await fetch(`${baseUrl}/sessions/${sid}/deliveries`);
        return response.ok && ((await response.json()).reports?.length || 0) > 0;
      }, { baseUrl: base, sid: sessionForReport }, { timeout: 10000 });
      await page.locator('button:has(svg.lucide-panel-right)').first().click({ timeout: 5000 });
      await page.getByRole('menuitemcheckbox', { name: /Verifiable delivery/i }).click({ timeout: 5000 });
      await page.keyboard.press('Escape');
      await page.getByText('Actual changes and verification evidence per run').waitFor({ timeout: 10000 });
      out.push('可验证交付面板读取本轮报告: true');
      await page.getByRole('switch', { name: 'Enable verifiable delivery mode' }).click({ timeout: 5000 });
      await page.waitForFunction(async ({ baseUrl, sid }) => {
        const response = await fetch(`${baseUrl}/sessions/${sid}`);
        return response.ok && (await response.json()).session?.state?.delivery_mode === false;
      }, { baseUrl: base, sid: sessionForReport }, { timeout: 10000 });
      await page.getByRole('switch', { name: 'Enable verifiable delivery mode' }).click({ timeout: 5000 });
      await page.waitForFunction(async ({ baseUrl, sid }) => {
        const response = await fetch(`${baseUrl}/sessions/${sid}`);
        return response.ok && (await response.json()).session?.state?.delivery_mode === true;
      }, { baseUrl: base, sid: sessionForReport }, { timeout: 10000 });
      await page.locator('#delivery-criteria').fill('The requested checks must pass');
      await page.getByRole('button', { name: 'Save criteria' }).click({ timeout: 5000 });
      await page.waitForFunction(async ({ baseUrl, sid }) => {
        const response = await fetch(`${baseUrl}/sessions/${sid}`);
        return response.ok && (await response.json()).session?.state?.delivery_criteria === 'The requested checks must pass';
      }, { baseUrl: base, sid: sessionForReport }, { timeout: 10000 });
      out.push('交付模式开关与验收要点持久化: true');
      const reportCountBefore = (await (await fetch(`${base}/sessions/${sessionForReport}/deliveries`)).json()).reports.length;
      await page.locator('textarea').first().fill('Please verify this small follow-up');
      await page.locator('textarea').first().press('Enter');
      await page.waitForFunction(async ({ baseUrl, sid, before }) => {
        const response = await fetch(`${baseUrl}/sessions/${sid}/deliveries`);
        if (!response.ok) return false;
        const reports = (await response.json()).reports || [];
        return reports.length > before && reports[0].modeEnabled === true;
      }, { baseUrl: base, sid: sessionForReport, before: reportCountBefore }, { timeout: 15000 });
      out.push('开启交付模式后的下一轮报告: true');
      await page.locator('button:has(svg.lucide-panel-right)').first().click({ timeout: 5000 });
      await page.getByRole('menuitemcheckbox', { name: /Project impact radar/i }).click({ timeout: 5000 });
      await page.keyboard.press('Escape');
      await page.getByText('Choose a project folder').waitFor({ timeout: 10000 });
      out.push('项目影响雷达面板空态渲染: true');
    }

    // 7. 非聊天工作台的路由级懒加载：打开自动化页再返回聊天，验证 chunk、
    // 路由状态和主输入框都能恢复。
    await page.getByText(/^(自动化|Automation)$/).first().click({ timeout: 5000 });
    await page.waitForURL(/\/schedule$/, { timeout: 10000 });
    await page.locator('main').getByText(/^(自动化|Automation)$/).waitFor({ timeout: 10000 });
    out.push('自动化路由按需加载: true');
    await page.getByText(/^(新任务|New task)$/i).first().click({ timeout: 5000 });
    await page.waitForURL(/\/chat(?:\/|$)/, { timeout: 10000 });
    await page.locator('textarea').first().waitFor({ timeout: 10000 });

    // 8. 设置按需加载：必须验证用户点击后模块真的能拉取、挂载和关闭。
    const profileMenu = page.getByRole('button', { name: /ui-smoke/i }).first();
    await profileMenu.click({ timeout: 5000 });
    await page.getByText(/^(设置|Settings)$/).first().click({ timeout: 5000 });
    await page.locator('h3').filter({ hasText: /^(通用|General)$/ }).waitFor({ timeout: 10000 });
    out.push('设置按需加载并打开: true');
    await page.getByText(/^(返回 CoCode|Back to CoCode)$/).click({ timeout: 5000 });
    await page.waitForTimeout(300);

    console.log(out.join('\n'));
    console.log('截图: ' + shots.map((s, i) => `${s}=/tmp/cocode-shot-${i + 1}-*.png`).join(', '));
    const unexpectedLogs = logs.filter((line) => !line.includes('status of 401'));
    if (unexpectedLogs.length) {
      console.log('\n页面错误（前10条）:');
      unexpectedLogs.slice(0, 10).forEach((l) => console.log(' -', l));
    } else {
      console.log('\n无阻断性页面错误 ✓');
    }
  } finally {
    await browser.close();
    // server.close 会等待 keep-alive 连接；测试页面刚取消的请求不应让 CI 无限挂住。
    // closeAllConnections 只作用于本脚本自行创建的临时 server。
    if (srv) {
      srv.closeAllConnections?.();
      await Promise.race([
        new Promise((resolve) => srv.close(resolve)),
        new Promise((resolve) => setTimeout(resolve, 1000))
      ]);
    }
    if (testHome) rmSync(testHome, { recursive: true, force: true });
  }
}
main().catch((e) => { console.error('失败:', e.message); process.exit(1); });
