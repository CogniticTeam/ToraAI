// 在隔离的未登录窗口验证语言搜索，以及弹窗覆盖登录页时的稳定性。
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright-core';

const chrome = [process.env.TORA_CHROME_PATH, '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', '/usr/bin/chromium'].find((path) => path && existsSync(path));
if (!chrome) throw new Error('找不到 Chrome/Chromium，请设置 TORA_CHROME_PATH');
const testHome = mkdtempSync(join(tmpdir(), 'tora-language-dialog-'));
process.env.TORA_HOME = testHome;
const { startASAPIServer } = await import('../packages/core/src/asapi/server.js');
const server = await startASAPIServer({ port: 0 });
const browser = await chromium.launch({ headless: true, executablePath: chrome, args: ['--no-sandbox'] });

try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, locale: 'zh-CN' });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.addInitScript(() => {
    localStorage.setItem('tora:first-run:intro:v1', '1');
    localStorage.setItem('tora:first-run:tour:v1', '1');
    localStorage.setItem('tora:first-use-consent:v1', JSON.stringify({ terms: true, privacy: true, crossBorder: true }));
    localStorage.setItem('tora_language_preference', 'zh');
    localStorage.setItem('tora.theme', 'dark');
    localStorage.removeItem('tora_auth_token');
    window.toraWindow = {
      isMaximized: () => false, onMaximizeChange: () => {},
      getSystemLocale: () => 'zh-CN', getRequiredUpdate: () => null, onRequiredUpdate: () => () => {}
    };
  });
  await page.goto(`http://127.0.0.1:${server.address().port}/`, { waitUntil: 'domcontentloaded' });
  await page.locator('input[autocomplete="username"]').waitFor({ state: 'visible' });
  const card = page.locator('.app-drag > .app-no-drag.relative.z-10');
  await page.waitForFunction(() => {
    const element = document.querySelector('.app-drag > .app-no-drag.relative.z-10');
    return element && getComputedStyle(element).opacity === '1';
  });
  await page.getByRole('button', { name: '语言' }).click();
  const dialog = page.getByRole('dialog', { name: '语言' });
  await dialog.waitFor({ state: 'visible' });
  const animations = await page.evaluate(() => ({
    open: document.querySelector('.app-drag[data-language-open]')?.getAttribute('data-language-open'),
    auroraA: getComputedStyle(document.querySelector('.auth-aurora-a')).animationPlayState,
    auroraB: getComputedStyle(document.querySelector('.auth-aurora-b')).animationPlayState,
    logo: getComputedStyle(document.querySelector('.brand-breathe')).animationPlayState,
  }));
  assert.deepEqual(animations, { open: 'true', auroraA: 'paused', auroraB: 'paused', logo: 'paused' });

  const search = dialog.getByRole('searchbox', { name: '搜索语言' });
  await search.waitFor({ state: 'visible' });
  // Compare settled layout, not the dialog's initial scale-in animation.
  await dialog.evaluate(async element => {
    await document.fonts.ready;
    await Promise.all(element.getAnimations({ subtree: true }).filter(animation => animation.effect?.getComputedTiming().iterations !== Infinity).map(animation => animation.finished.catch(() => {})));
  });
  const dialogHeight = (await dialog.boundingBox()).height;
  await search.fill('traditional');
  assert.equal(await dialog.getByRole('button', { name: /繁體中文/ }).count(), 1);
  assert.equal(await dialog.getByRole('button', { name: /简体中文/ }).count(), 0);
  await search.fill('繁體');
  assert.equal(await dialog.getByRole('button', { name: /繁體中文/ }).count(), 1, '繁简中文名称都应可搜索');
  await search.fill('not-a-language');
  assert.equal(await dialog.getByRole('status').getByText('没有匹配的语言').isVisible(), true);
  assert.ok(Math.abs((await dialog.boundingBox()).height - dialogHeight) < 1, '搜索结果变化不应使居中弹窗上下跳动');
  await search.fill('');
  assert.equal(await dialog.locator('button[aria-pressed]').count(), 14);
  await page.screenshot({ path: join(tmpdir(), 'tora-language-search-login.png') });

  const cardBounds = await card.boundingBox();
  await page.waitForTimeout(300);
  const cardAfter = await card.boundingBox();
  assert.ok(Math.abs(cardBounds.x - cardAfter.x) < 1 && Math.abs(cardBounds.y - cardAfter.y) < 1,
    '打开语言弹窗后登录卡片不应移动');
  await search.fill('english');
  await dialog.getByRole('button', { name: 'English', exact: true }).click();
  await dialog.waitFor({ state: 'hidden' });
  assert.equal(await page.evaluate(() => localStorage.getItem('tora_language_preference')), 'en');
  assert.equal(await page.locator('.app-drag[data-language-open]').getAttribute('data-language-open'), 'false');
  assert.equal(await page.locator('input[autocomplete="username"]').isVisible(), true);
  await page.setViewportSize({ width: 390, height: 760 });
  await page.getByRole('button', { name: 'Language' }).click();
  await page.getByRole('dialog', { name: 'Language' }).waitFor({ state: 'visible' });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), true,
    '窄窗口下语言弹窗不能造成横向溢出');
  assert.deepEqual(errors, [], `页面脚本错误：${errors.join(' | ')}`);
  console.log('语言搜索、多语名称、无结果、弹窗稳定与窄窗口布局：通过');
} finally {
  await browser.close();
  server.closeAllConnections?.();
  await Promise.race([new Promise((resolve) => server.close(resolve)), new Promise((resolve) => setTimeout(resolve, 1000))]);
  rmSync(testHome, { recursive: true, force: true });
}
