import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright-core';

// 本地独立 ASAPI + Wrangler D1 fixture，不触及线上账户或投票。
process.env.COCODE_HOME = mkdtempSync(join(tmpdir(), 'cocode-polls-ui-'));
const { startASAPIServer } = await import('../packages/core/src/asapi/server.js');
const server = await startASAPIServer({ port: 0 });
const base = `http://127.0.0.1:${server.address().port}`;
const workerBase = process.env.POLL_TEST_BASE || 'http://127.0.0.1:8792';
const template = {
  title: '界面验证 ' + crypto.randomUUID().slice(0, 8), description: '本地投票界面测试',
  startAt: new Date(Date.now() - 60_000).toISOString(), endAt: new Date(Date.now() + 3_600_000).toISOString(),
  type: 'single', maxSelections: 1, audience: 'all', frequency: 'once', resultVisibility: 'live',
  showVoterCount: true, showDetails: true, options: [{ label: '支持' }, { label: '反对' }], publish: true,
};
const createdResponse = await fetch(workerBase + '/admin/polls', { method: 'POST', headers: { authorization: 'Bearer local-test-admin', 'content-type': 'application/json' }, body: JSON.stringify(template) });
assert.equal(createdResponse.status, 201);
const created = await createdResponse.json();
const createdPollIds = [created.id];
const browser = await chromium.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 820 }, locale: 'zh-CN', colorScheme: 'dark' });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('dialog', dialog => void dialog.accept());
  await page.addInitScript(({ base }) => {
    for (const [key, value] of Object.entries({ server_url: base, username: 'cocode', cocode_auth_token: 'local-user-one', cocode_auth_username: '管理测试一', cocode_cn_notice_agreed_v1: '1', cocode_language_preference: 'zh', theme: 'dark' })) localStorage.setItem(key, value);
  }, { base });
  let simulateInitialPages = true;
  let failNextPollLoad = false;
  let initialPolls;
  await page.route('https://cocode.ohfun.online/**', async route => {
    const source = route.request();
    const url = new URL(source.url());
    if (url.pathname === '/polls' && source.method() === 'GET') {
      const fulfill = (status, data) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(data), headers: { 'access-control-allow-origin': '*' } });
      if (failNextPollLoad) {
        failNextPollLoad = false;
        await new Promise(resolve => setTimeout(resolve, 450));
        await fulfill(503, { detail: '模拟投票加载失败' });
        return;
      }
      if (simulateInitialPages) {
        if (!initialPolls) {
          const response = await fetch(workerBase + '/polls?offset=0', { headers: source.headers() });
          initialPolls = (await response.json()).polls;
        }
        const target = initialPolls.find(poll => poll.id === created.id);
        assert.ok(target);
        const otherPolls = initialPolls.filter(poll => poll.id !== created.id);
        if (url.searchParams.get('offset') === '0') { await fulfill(200, { polls: otherPolls.slice(0, 1), nextOffset: 50 }); return; }
        if (url.searchParams.get('offset') === '50') {
          await new Promise(resolve => setTimeout(resolve, 1400));
          simulateInitialPages = false;
          await fulfill(200, { polls: [...otherPolls.slice(1), target], nextOffset: null });
          return;
        }
      }
    }
    const response = await fetch(workerBase + url.pathname + url.search, { method: source.method(), headers: source.headers(), ...(source.postDataBuffer() ? { body: source.postDataBuffer() } : {}) });
    await route.fulfill({ status: response.status, contentType: response.headers.get('content-type') || 'application/json', body: Buffer.from(await response.arrayBuffer()), headers: { 'access-control-allow-origin': '*' } });
  });
  const secondPageRequest = page.waitForRequest(request => {
    const url = new URL(request.url());
    return url.pathname === '/polls' && url.searchParams.get('offset') === '50';
  });
  await page.goto(base + '/polls');
  await page.getByRole('heading', { name: '投票', exact: true }).waitFor();
  await secondPageRequest;
  await page.getByText('正在加载投票中').waitFor();
  assert.equal(await page.getByRole('button', { name: new RegExp(template.title) }).count(), 0);
  assert.equal(await page.getByPlaceholder('搜索投票标题').count(), 0);
  assert.equal(await page.getByLabel('创建时间起').count(), 0);
  await page.getByRole('button', { name: new RegExp(template.title) }).waitFor();
  const pollNav = page.getByRole('button', { name: '投票', exact: true });
  await pollNav.waitFor();
  const hideEntry = await fetch(workerBase + '/admin/polls/settings', { method: 'PATCH', headers: { authorization: 'Bearer local-test-admin', 'content-type': 'application/json' }, body: JSON.stringify({ entryVisible: false }) });
  assert.equal(hideEntry.status, 200);
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await pollNav.waitFor({ state: 'hidden' });
  assert.equal(await page.getByRole('heading', { name: '投票', exact: true }).isVisible(), true);
  const showEntry = await fetch(workerBase + '/admin/polls/settings', { method: 'PATCH', headers: { authorization: 'Bearer local-test-admin', 'content-type': 'application/json' }, body: JSON.stringify({ entryVisible: true }) });
  assert.equal(showEntry.status, 200);
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await pollNav.waitFor();
  failNextPollLoad = true;
  await page.getByRole('button', { name: '刷新投票' }).click();
  await page.getByText('正在加载投票中').waitFor();
  assert.equal(await page.getByRole('button', { name: new RegExp(template.title) }).count(), 0);
  await page.getByText('投票加载失败', { exact: true }).waitFor();
  await page.getByRole('button', { name: '重试' }).click();
  await page.getByRole('button', { name: new RegExp(template.title) }).click();
  await page.getByText('本地投票界面测试').first().waitFor();
  await page.getByRole('radio').first().check();
  await page.getByRole('button', { name: '提交投票' }).click();
  await page.getByText('投票已提交').waitFor();
  const scheduledTitle = '倒计时验证 ' + crypto.randomUUID().slice(0, 8);
  const scheduledResponse = await fetch(workerBase + '/admin/polls', {
    method: 'POST', headers: { authorization: 'Bearer local-test-admin', 'content-type': 'application/json' },
    body: JSON.stringify({ ...template, title: scheduledTitle, description: '本地倒计时界面测试', startAt: new Date(Date.now() + 8500).toISOString() }),
  });
  assert.equal(scheduledResponse.status, 201);
  createdPollIds.push((await scheduledResponse.json()).id);
  await page.getByRole('button', { name: '刷新投票' }).click();
  const scheduledCard = page.getByRole('button', { name: new RegExp(scheduledTitle) });
  await scheduledCard.waitFor();
  await scheduledCard.click();
  await page.getByText('本地倒计时界面测试').first().waitFor();
  const countdown = scheduledCard.getByRole('timer');
  await countdown.waitFor();
  const initialCountdown = await countdown.textContent();
  assert.match(initialCountdown, /^距开始 \d\d:\d\d:\d\d$/);
  assert.equal(await page.getByRole('button', { name: '提交投票' }).isDisabled(), true);
  await page.waitForFunction(initial => [...document.querySelectorAll('[role="timer"]')].some(node => node.textContent !== initial), initialCountdown);
  await page.screenshot({ path: '/private/tmp/cocode-polls-countdown-ui.png' });
  await scheduledCard.getByText('进行中').waitFor({ timeout: 15000 });
  await page.waitForFunction(() => [...document.querySelectorAll('button')].some(button => button.textContent?.includes('提交投票') && !button.disabled));
  assert.equal(await scheduledCard.getByRole('timer').count(), 0);
  await page.screenshot({ path: '/private/tmp/cocode-polls-user-ui.png' });
  assert.deepEqual(errors, []);
  console.log('通过：全部分页加载后显示、失败重试、用户投票与开始倒计时自动刷新。');
} finally {
  await fetch(workerBase + '/admin/polls/settings', { method: 'PATCH', headers: { authorization: 'Bearer local-test-admin', 'content-type': 'application/json' }, body: JSON.stringify({ entryVisible: true }) }).catch(() => {});
  await browser.close();
  server.close();
  for (const id of createdPollIds) await fetch(workerBase + '/admin/polls/' + id, { method: 'DELETE', headers: { authorization: 'Bearer local-test-admin' } });
}
