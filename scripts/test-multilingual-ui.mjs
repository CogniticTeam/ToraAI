// 逐一打开新语言的真实登录页和 Language 弹窗，验证按需词库及 RTL。
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright-core';

const chrome = [process.env.TORA_CHROME_PATH, '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', '/usr/bin/chromium'].find((path) => path && existsSync(path));
if (!chrome) throw new Error('找不到 Chrome/Chromium，请设置 TORA_CHROME_PATH');
const testHome = mkdtempSync(join(tmpdir(), 'tora-multilingual-ui-'));
process.env.TORA_HOME = testHome;
const { startASAPIServer } = await import('../packages/core/src/asapi/server.js');
const server = await startASAPIServer({ port: 0 });
const browser = await chromium.launch({ headless: true, executablePath: chrome, args: ['--no-sandbox'] });
const base = `http://127.0.0.1:${server.address().port}`;
const languages = process.env.TORA_TEST_LANGUAGE === 'dynamic' ? [] : process.env.TORA_TEST_LANGUAGE ? [process.env.TORA_TEST_LANGUAGE]
  : ['ja', 'ko', 'fr', 'de', 'it', 'ar', 'es', 'pt', 'ru', 'hi', 'lzh'];
const locale = (name) => JSON.parse(readFileSync(new URL(`../packages/desktop/frontend/src/i18n/locales/${name}.json`, import.meta.url), 'utf8'));

try {
  for (const language of languages) {
    const expected = locale(language);
    const context = await browser.newContext({ viewport: { width: 1100, height: 760 }, locale: 'en-US' });
    try {
      await context.addInitScript(({ language }) => {
        localStorage.setItem('tora:first-run:intro:v1', '1');
        localStorage.setItem('tora:first-run:tour:v1', '1');
        localStorage.setItem('tora:first-use-consent:v1', JSON.stringify({ terms: true, privacy: true, crossBorder: true }));
        localStorage.setItem('tora_language_preference', language);
        localStorage.removeItem('tora_auth_token');
        window.toraWindow = {
          isMaximized: () => false, onMaximizeChange: () => {},
          getSystemLocale: () => language, getRequiredUpdate: () => null, onRequiredUpdate: () => () => {}
        };
      }, { language });
      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', (error) => errors.push(error.message));
      await page.goto(base, { waitUntil: 'domcontentloaded' });
      await page.locator('input[autocomplete="username"]').waitFor({ state: 'visible', timeout: 15000 });
      assert.equal(await page.evaluate(() => document.documentElement.lang), language);
      assert.equal(await page.evaluate(() => document.documentElement.dir), language === 'ar' ? 'rtl' : 'ltr');
      await page.getByRole('heading', { name: expected.settings.account.homeTitle }).waitFor({ state: 'visible' });
      if (language === 'ar') {
        const input = await page.locator('input[autocomplete="username"]').boundingBox();
        const label = await page.locator('input[autocomplete="username"] ~ label').boundingBox();
        assert.ok(Math.abs((label.x + label.width) - (input.x + input.width)) < 30,
          `阿拉伯语登录输入标签应靠右：input=${JSON.stringify(input)} label=${JSON.stringify(label)}`);
        await page.screenshot({ path: join(tmpdir(), 'tora-login-ar.png') });
      }
      await page.getByRole('button', { name: expected.settings.general.language.title }).click();
      const dialog = page.getByRole('dialog', { name: expected.languageDialog.title });
      await dialog.waitFor({ state: 'visible' });
      const search = dialog.getByRole('searchbox', { name: expected.languageDialog.search });
      assert.equal(await search.isVisible(), true);
      assert.equal(await dialog.locator('button[aria-pressed]').count(), 14);
      await search.fill('日本語');
      assert.equal(await dialog.locator('button[aria-pressed]').count(), 1, `${language} 的跨语言搜索失效`);
      if (['ja', 'ar', 'lzh'].includes(language)) await page.screenshot({ path: join(tmpdir(), `tora-language-${language}.png`) });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), true,
        `${language} 出现横向溢出`);
      assert.deepEqual(errors, [], `${language} 页面脚本错误：${errors.join(' | ')}`);
      console.log(`${language}: 语言切换、登录页、搜索与布局通过`);
    } finally {
      await context.close();
    }
  }

  if (!process.env.TORA_TEST_LANGUAGE || process.env.TORA_TEST_LANGUAGE === 'dynamic') {
    const context = await browser.newContext({ viewport: { width: 1100, height: 760 }, locale: 'en-US' });
    try {
      await context.addInitScript(() => {
        localStorage.setItem('tora:first-run:intro:v1', '1');
        localStorage.setItem('tora:first-run:tour:v1', '1');
        localStorage.setItem('tora:first-use-consent:v1', JSON.stringify({ terms: true, privacy: true, crossBorder: true }));
        if (!localStorage.getItem('tora_language_preference')) localStorage.setItem('tora_language_preference', 'en');
        localStorage.removeItem('tora_auth_token');
        window.toraWindow = {
          isMaximized: () => false, onMaximizeChange: () => {},
          getSystemLocale: () => 'en-US', getRequiredUpdate: () => null, onRequiredUpdate: () => () => {}
        };
      });
      const page = await context.newPage();
      await page.goto(base, { waitUntil: 'domcontentloaded' });
      await page.getByRole('button', { name: 'Language' }).click();
      const dialog = page.getByRole('dialog', { name: 'Language' });
      await dialog.getByRole('searchbox', { name: 'Search languages' }).fill('日本語');
      await dialog.getByRole('button', { name: /日本語/ }).click();
      await dialog.waitFor({ state: 'hidden' });
      await page.waitForFunction(() => document.documentElement.lang === 'ja');
      await page.locator('h3').filter({ hasText: locale('ja').settings.account.homeTitle }).waitFor();
      assert.equal(await page.evaluate(() => localStorage.getItem('tora_language_preference')), 'ja');
      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.getByRole('heading', { name: locale('ja').settings.account.homeTitle }).waitFor();
      console.log('从英语动态切换到日语并在重启后保持：通过');
    } finally {
      await context.close();
    }
  }
  if (!process.env.TORA_TEST_LANGUAGE) {
    const context = await browser.newContext({ viewport: { width: 1360, height: 850 }, locale: 'ar-SA' });
    try {
      await context.addInitScript(({ base }) => {
        localStorage.setItem('server_url', base);
        localStorage.setItem('tora_auth_token', 'i18n-smoke-token');
        localStorage.setItem('username', 'i18n-smoke');
        localStorage.setItem('tora_language_preference', 'ar');
        localStorage.setItem('tora:first-run:intro:v1', '1');
        localStorage.setItem('tora:first-run:tour:v1', '1');
        localStorage.setItem('tora:first-use-consent:v1', JSON.stringify({ terms: true, privacy: true, crossBorder: true }));
        window.toraWindow = {
          isMaximized: () => false, onMaximizeChange: () => {},
          getSystemLocale: () => 'ar-SA', getRequiredUpdate: () => null, onRequiredUpdate: () => () => {}
        };
      }, { base });
      const page = await context.newPage();
      await page.route('https://tora.ohfun.online/auth/me', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ id: 'i18n-smoke', username: 'i18n-smoke' }) }));
      await page.route('https://tora.ohfun.online/models', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ models: [] }) }));
      await page.route('https://tora.ohfun.online/polls/config', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ enabled: true, entryVisible: true }) }));
      await page.route('https://tora.ohfun.online/account/messages', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ messages: [], unread: 0 }) }));
      await page.route('https://tora.ohfun.online/account/events-ticket', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ticket: 'i18n-smoke-ticket' }) }));
      await page.routeWebSocket('wss://tora.ohfun.online/account/events*', (socket) => { socket.onMessage((message) => { if (message === 'ping') socket.send('pong'); }); });
      await page.goto(base, { waitUntil: 'domcontentloaded' });
      await page.locator('textarea:visible').first().waitFor({ timeout: 15000 });
      assert.equal(await page.evaluate(() => document.documentElement.lang), 'ar');
      assert.equal(await page.evaluate(() => document.documentElement.dir), 'rtl');
      await page.getByRole('button', { name: /i18n-smoke/i }).first().click();
      await page.getByRole('menuitem', { name: locale('ar').common.settings }).click();
      await page.locator('h3').filter({ hasText: locale('ar').settings.general.title }).waitFor();
      const row = page.getByText(locale('ar').settings.general.language.desc, { exact: true }).locator('..').locator('..');
      await row.getByRole('button').click();
      assert.equal(await page.getByRole('listbox').getByRole('option').count(), 14);
      await page.getByRole('option', { name: locale('ar').settings.general.language.ja }).click();
      await page.waitForFunction(() => document.documentElement.lang === 'ja' && document.documentElement.dir === 'ltr');
      console.log('阿拉伯语工作区、设置页及切换到日语：通过');
    } finally {
      await context.close();
    }
  }
} finally {
  await browser.close();
  server.closeAllConnections?.();
  await Promise.race([new Promise((resolve) => server.close(resolve)), new Promise((resolve) => setTimeout(resolve, 1000))]);
  rmSync(testHome, { recursive: true, force: true });
}
