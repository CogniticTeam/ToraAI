// 真实前端 + 隔离本地工作区；只 mock 云端网络，绝不操作真实用户。
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
process.env.TORA_HOME = mkdtempSync(join(tmpdir(), 'tora-translation-ui-'));
const { startASAPIServer } = await import('../packages/core/src/asapi/server.js');
const server = await startASAPIServer({ port: 0 });
const base = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
try {
  for (const language of ['zh', 'en']) {
    const page = await browser.newPage({ locale: language === 'zh' ? 'zh-CN' : 'en-US' });
    const errors = [];
    let calls = 0;
    page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(({ base, language }) => {
      for (const [key, value] of Object.entries({ server_url: base, username: 'tora', tora_auth_token: 'mock-session', tora_auth_username: 'TranslationTest', tora_cn_notice_agreed_v1: '1', tora_language_preference: language })) localStorage.setItem(key, value);
    }, { base, language });
    await page.route('https://tora.ohfun.online/**', async route => {
      const path = new URL(route.request().url()).pathname;
      const reply = (data, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(data) });
      if (path === '/auth/me') return reply({ id: 1, email: 'test@example.invalid', username: 'TranslationTest', banned: false });
      if (path === '/account/messages/translate') {
        calls++;
        const data = route.request().postDataJSON();
        assert.equal(data.targetLanguage, language);
        assert.equal(data.id, language === 'zh' ? 'en' : 'zh');
        if (calls === 1) return reply({ code: 'TRANSLATION_FAILED' }, 502);
        await new Promise(resolve => setTimeout(resolve, 300));
        return reply({ translated: true, targetLanguage: language, title: language === 'zh' ? '翻译测试标题' : 'Translated notice', body: language === 'zh' ? '翻译后的正文。<script>不得执行</script>' : 'Translated body. <script>must not run</script>' });
      }
      if (path === '/account/messages/read') return reply({ ok: true });
      if (path === '/account/messages') return reply({ unread: 0, nextOffset: null, messages: [
        { id: 'zh', title: '中文通知', body: '请重新打开应用。', source_language: 'zh', created_at: new Date().toISOString(), read_at: 'read' },
        { id: 'en', title: 'English notice', body: 'Please reopen the app.', source_language: 'en', created_at: new Date().toISOString(), read_at: 'read' },
      ] });
      if (path === '/models') return reply({ models: [] });
      return reply({}, 503); // 使用轮询兜底，不连接真实 WebSocket。
    });
    await page.goto(base);
    await page.getByRole('button', { name: /TranslationTest/ }).click();
    await page.getByRole('menuitem', { name: language === 'zh' ? /消息/ : /Messages/ }).click();
    const translate = page.getByRole('button', { name: language === 'zh' ? '翻译为简体中文' : 'Translate to English (US)', exact: true });
    await page.getByRole('button', { name: language === 'zh' ? /中文通知/ : /English notice/ }).click();
    assert.equal(await page.getByRole('button', { name: language === 'zh' ? '无需翻译' : 'No translation needed' }).isDisabled(), true);
    await page.getByRole('button', { name: language === 'zh' ? /返回消息列表/ : /Back to messages/ }).click();
    await page.getByRole('button', { name: language === 'zh' ? /English notice/ : /中文通知/ }).click();
    assert.equal(calls, 0);
    await translate.click();
    await page.getByRole('alert').filter({ hasText: language === 'zh' ? /翻译失败/ : /Translation failed/ }).waitFor();
    await translate.click();
    await page.getByRole('button', { name: language === 'zh' ? '翻译中…' : 'Translating…' }).waitFor();
    const original = page.getByRole('button', { name: language === 'zh' ? '查看原文' : 'Show original', exact: true });
    await original.waitFor();
    const translatedTitle = language === 'zh' ? '翻译测试标题' : 'Translated notice';
    await page.getByRole('heading', { name: translatedTitle }).waitFor();
    assert.ok(await page.getByText('<script>', { exact: false }).isVisible());
    await original.click();
    await page.getByRole('heading', { name: language === 'zh' ? 'English notice' : '中文通知' }).waitFor();
    await page.getByRole('button', { name: language === 'zh' ? '查看译文' : 'Show translation' }).click();
    await page.getByRole('heading', { name: translatedTitle }).waitFor();
    assert.equal(calls, 2); // 一次失败、一次成功；原文/译文切换无请求。
    assert.deepEqual(errors, []);
    await page.screenshot({ path: `/private/tmp/tora-translation-${language}.png` });
    console.log(`通过 ${language}：详情内同语言禁用、异语言翻译、失败重试、加载占位、原文切换、纯文本安全渲染。`);
    await page.close();
  }
  // 其余界面语言必须发送各自的目标代码，不能再统一退回英文。
  for (const language of ['en-GB', 'en-US', 'zh-HK', 'zh-TW', 'ja', 'ko', 'fr', 'de', 'it', 'ar', 'es', 'pt', 'ru', 'hi', 'lzh']) {
    const locale = JSON.parse(readFileSync(new URL(`../packages/desktop/frontend/src/i18n/locales/${language}.json`, import.meta.url), 'utf8'));
    const apiLanguage = {'en-GB':'en','en-US':'en','zh-HK':'zh-Hant','zh-TW':'zh-Hant'}[language] ?? language;
    const optionKey = language === 'en-GB' ? 'enGB' : language === 'en-US' ? 'enUS' : language === 'zh-HK' ? 'zhHK' : language === 'zh-TW' ? 'zhTW' : language;
    const label = locale.inbox.translateToLanguage.replace('{{language}}', locale.settings.general.language[optionKey]);
    const page = await browser.newPage();
    let calls = 0;
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(({ base, language }) => {
      for (const [key, value] of Object.entries({ server_url: base, username: 'tora', tora_auth_token: 'mock-session', tora_auth_username: 'TranslationTest', tora_cn_notice_agreed_v1: '1', tora_language_preference: language })) localStorage.setItem(key, value);
    }, { base, language });
    await page.route('https://tora.ohfun.online/**', async route => {
      const path = new URL(route.request().url()).pathname;
      const reply = data => route.fulfill({ contentType: 'application/json', body: JSON.stringify(data) });
      if (path === '/auth/me') return reply({ id: 1, email: 'test@example.invalid', username: 'TranslationTest', banned: false });
      if (path === '/account/messages') return reply({ unread: 0, nextOffset: null, messages: [{ id: 'unknown', title: '多语言通知', body: 'Bonjour, 请重新打开应用。', source_language: null, created_at: new Date().toISOString(), read_at: 'read' }] });
      if (path === '/account/messages/translate') {
        calls++;
        assert.deepEqual(route.request().postDataJSON(), { id: 'unknown', targetLanguage: language });
        return reply({ translated: true, targetLanguage: apiLanguage, title: `Translated ${language}`, body: `Body ${language}` });
      }
      if (path === '/models') return reply({ models: [] });
      return route.fulfill({ status: 503, contentType: 'application/json', body: '{}' });
    });
    await page.goto(base);
    await page.getByRole('button', { name: /TranslationTest/ }).click();
    await page.getByRole('menuitem', { name: locale.inbox.title, exact: true }).click();
    await page.getByRole('button', { name: /多语言通知/ }).click();
    const translate = page.getByRole('button', { name: label, exact: true });
    assert.equal(await translate.isDisabled(), false, `${language} 不应禁用未知语言`);
    await translate.click();
    await page.getByRole('heading', { name: `Translated ${language}` }).waitFor();
    await page.getByRole('button', { name: locale.inbox.showOriginal, exact: true }).click();
    await page.getByRole('heading', { name: '多语言通知' }).waitFor();
    await page.getByRole('button', { name: locale.inbox.showTranslation, exact: true }).click();
    await page.getByRole('heading', { name: `Translated ${language}` }).waitFor();
    assert.equal(calls, 1);
    assert.deepEqual(errors, []);
    assert.equal(await page.locator('html').getAttribute('lang'), language);
    if (['en-GB', 'en-US', 'zh-HK', 'zh-TW', 'ja', 'ar'].includes(language)) await page.screenshot({ path: `/private/tmp/tora-translation-${language}.png` });
    console.log(`通过 ${language}：本地化目标文案、未知原文可翻译、目标代码和译文缓存正确。`);
    await page.close();
  }
} finally { await browser.close(); server.close(); }
