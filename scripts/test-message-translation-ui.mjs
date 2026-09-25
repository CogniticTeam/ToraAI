// 真实前端 + 隔离本地工作区；只 mock 云端网络，绝不操作真实用户。
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
process.env.COCODE_HOME = mkdtempSync(join(tmpdir(), 'cocode-translation-ui-'));
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
      for (const [key, value] of Object.entries({ server_url: base, username: 'cocode', cocode_auth_token: 'mock-session', cocode_auth_username: 'TranslationTest', cocode_cn_notice_agreed_v1: '1', cocode_language_preference: language })) localStorage.setItem(key, value);
    }, { base, language });
    await page.route('https://cocode.ohfun.online/**', async route => {
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
    const translate = page.getByRole('button', { name: language === 'zh' ? '翻译为中文' : 'Translate to English', exact: true });
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
    await page.screenshot({ path: `/private/tmp/cocode-translation-${language}.png` });
    console.log(`通过 ${language}：详情内同语言禁用、异语言翻译、失败重试、加载占位、原文切换、纯文本安全渲染。`);
    await page.close();
  }
} finally { await browser.close(); server.close(); }
