import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright-core';

const chrome = [process.env.TORA_CHROME_PATH, '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome'].find(path => path && existsSync(path));
if (!chrome) throw new Error('找不到 Chrome/Chromium');
const home = mkdtempSync(join(tmpdir(), 'tora-catgirl-ui-'));
process.env.TORA_HOME = home;
const { startASAPIServer } = await import('../packages/core/src/asapi/server.js');
const { saveConfig, loadConfig } = await import('../packages/core/src/config.js');
const server = await startASAPIServer({ port: 0 });
const base = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ headless: true, executablePath: chrome, args: ['--no-sandbox'] });
const output = new URL('../output/catgirl-qa/', import.meta.url).pathname;
mkdirSync(output, { recursive: true });
const errors = [];
async function open(language) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 850 }, locale: language === 'ja' ? 'ja-JP' : 'zh-CN' });
  const page = await context.newPage();
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(({ base, language }) => {
    if (!localStorage.getItem('tora_language_preference')) localStorage.setItem('tora_language_preference', language);
    localStorage.setItem('server_url', base);
    localStorage.setItem('tora_auth_token', 'catgirl-test-token');
    localStorage.setItem('username', 'catgirl-test');
    localStorage.setItem('tora:first-run:intro:v1', '1');
    localStorage.setItem('tora:first-run:tour:v1', '1');
    localStorage.setItem('tora:first-use-consent:v1', JSON.stringify({ terms: true, privacy: true, crossBorder: true }));
    window.toraWindow = {
      isMaximized: () => false, onMaximizeChange: () => {}, getSystemLocale: () => language,
      reportLanguage: () => {}, reportTheme: () => {}, getRequiredUpdate: () => null,
      onRequiredUpdate: () => () => {}, refreshAccount: async () => {},
      onMenuCommand: () => () => {}, getAppVersion: () => '1.0.1',
    };
  }, { base, language });
  await page.route('https://tora.ohfun.online/**', route => {
    const path = new URL(route.request().url()).pathname;
    const body = {
      '/auth/me': { id: 'catgirl-test', username: 'catgirl-test' },
      '/models': { models: [] }, '/polls/config': { enabled: false, entryVisible: false },
      '/account/messages': { messages: [], unread: 0 }, '/account/events-ticket': { ticket: 'fixture' },
    }[path] || {};
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
  });
  await page.routeWebSocket('wss://tora.ohfun.online/account/events*', socket => socket.onMessage(message => { if (message === 'ping') socket.send('pong'); }));
  await page.goto(base, { waitUntil: 'domcontentloaded' });
  await page.locator('#tour-chat-textarea').first().waitFor({ state: 'visible' });
  return { context, page, input: page.locator('#tour-chat-textarea').first() };
}
async function preference(page, language) {
  await page.evaluate(language => localStorage.setItem('tora_language_preference', language), language);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.locator('#tour-chat-textarea').first().waitFor({ state: 'visible' });
}
async function settings(page, section = 'agent') {
  await page.evaluate(section => window.dispatchEvent(new CustomEvent('tora:open-settings', { detail: section })), section);
  await page.locator('[role="switch"]#catgirl-persona').waitFor({ state: 'visible' });
}
async function settleDialog(dialog) {
  await dialog.evaluate(async element => {
    await document.fonts.ready;
    await Promise.all(element.getAnimations({ subtree: true }).filter(animation => animation.effect?.getComputedTiming().iterations !== Infinity).map(animation => animation.finished.catch(() => {})));
  });
}
try {
  saveConfig({ catgirlLanguagePackInstalled: false, catgirlPersonaEnabled: false });
  const { context, page, input } = await open('zh');
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('tora:open-settings', { detail: 'general' })));
  await page.getByRole('combobox', { name: '语言', exact: true }).click();
  assert.equal(await page.getByRole('option').count(), 16, '未解锁时语言列表维持原有语言');
  assert.equal(await page.getByRole('option', { name: /猫娘/ }).count(), 0);
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: '智能体', exact: true }).click();
  assert.equal(await page.locator('#catgirl-persona').count(), 0, '未解锁时隐藏人格开关');
  await page.getByRole('button', { name: '返回 Tora', exact: true }).click();
  await page.getByRole('button', { name: /catgirl-test/ }).first().click();
  assert.equal(await page.getByTestId('disable-catgirl-language-pack').count(), 0, '未添加时菜单没有停用入口');
  await page.keyboard.press('Escape');
  // 暗号只匹配全部输入；日语暗号在中文界面不触发。
  for (const text of ['我想说喵喵喵', '猫娘語', 'にゃにゃにゃ']) {
    await input.fill(text); assert.equal(await page.getByRole('dialog').count(), 0);
  }
  await input.fill('猫娘语');
  const dialog = page.getByRole('dialog', { name: '是否添加猫娘语言包？' });
  await dialog.waitFor({ state: 'visible' });
  await dialog.getByRole('button', { name: '暂时不要' }).click();
  assert.equal(await input.inputValue(), '猫娘语');
  assert.equal(loadConfig().catgirlLanguagePackInstalled, false);
  await input.fill('');
  // 模拟中文输入法：组字中保持输入框，组字结束后再弹窗。
  await input.dispatchEvent('compositionstart');
  await input.fill('喵喵喵');
  assert.equal(await page.getByRole('dialog').count(), 0);
  await input.dispatchEvent('compositionend');
  await dialog.waitFor({ state: 'visible' });
  await settleDialog(dialog);
  await page.screenshot({ path: join(output, 'zh-easter-egg.png') });
  await page.setViewportSize({ width: 390, height: 760 });
  const bounds = await dialog.boundingBox();
  assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= 390, '窄窗口的彩蛋弹窗不溢出');
  await page.setViewportSize({ width: 1280, height: 850 });
  await page.route(base + '/admin/catgirl', async route => {
    if (route.request().method() === 'POST') { await page.unroute(base + '/admin/catgirl'); return route.fulfill({ status: 503, body: 'fixture failure' }); }
    return route.continue();
  });
  await dialog.getByRole('button', { name: '添加语言包' }).click();
  await dialog.getByRole('alert').waitFor({ state: 'visible' });
  assert.equal(loadConfig().catgirlLanguagePackInstalled, false);
  await dialog.getByRole('button', { name: '添加语言包' }).click();
  await dialog.waitFor({ state: 'hidden' });
  await page.waitForFunction(() => document.documentElement.lang === 'zh-Neko');
  assert.equal(await input.inputValue(), '');
  assert.match(await input.getAttribute('placeholder'), /本喵/);
  assert.equal(loadConfig().catgirlPersonaEnabled, false);
  await settings(page);
  const toggle = page.getByRole('switch', { name: '猫娘人格', exact: true });
  await toggle.click();
  await page.waitForFunction(base => fetch(base + '/admin/catgirl').then(r => r.json()).then(s => s.enabled), base);
  await page.waitForFunction(() => document.querySelector('#catgirl-persona')?.getAttribute('aria-checked') === 'true');
  await page.screenshot({ path: join(output, 'zh-persona-settings.png') });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await input.waitFor({ state: 'visible' });
  assert.equal(await page.evaluate(() => document.documentElement.lang), 'zh-Neko');
  await settings(page);
  await toggle.waitFor({ state: 'visible' });
  assert.equal(await toggle.getAttribute('aria-checked'), 'true');
  await toggle.click();
  await page.waitForFunction(base => fetch(base + '/admin/catgirl').then(r => r.json()).then(s => !s.enabled), base);
  await preference(page, 'zh');
  // 普通界面中的设置列表也包含两套猫娘语言。
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('tora:open-settings', { detail: 'general' })));
  await page.getByRole('combobox', { name: '语言', exact: true }).click();
  assert.equal(await page.getByRole('option', { name: '猫娘语（中文）' }).count(), 1);
  assert.equal(await page.getByRole('option', { name: '猫娘語（日本語）' }).count(), 1);
  await page.getByRole('option', { name: '猫娘語（日本語）' }).click();
  await page.waitForFunction(() => document.documentElement.lang === 'ja-Neko');
  await page.reload({ waitUntil: 'domcontentloaded' });
  await input.waitFor({ state: 'visible' });
  await settings(page);
  await toggle.click();
  await page.waitForFunction(() => document.querySelector('#catgirl-persona')?.getAttribute('aria-checked') === 'true');
  await page.reload({ waitUntil: 'domcontentloaded' });
  await input.waitFor({ state: 'visible' });
  await page.route(base + '/admin/catgirl', async route => {
    if (route.request().method() === 'POST') { await page.unroute(base + '/admin/catgirl'); return route.fulfill({ status: 503, body: 'fixture failure' }); }
    return route.continue();
  });
  await page.getByRole('button', { name: /catgirl-test/ }).first().click();
  await page.getByRole('menuitem', { name: '猫娘言語パックを無効にする' }).click();
  await page.getByText('無効にできませんでした。もう一度お試しください。', { exact: true }).waitFor({ state: 'visible' });
  assert.equal(await page.evaluate(() => document.documentElement.lang), 'ja-Neko');
  assert.equal(loadConfig().catgirlLanguagePackInstalled, true);
  assert.equal(loadConfig().catgirlPersonaEnabled, true);
  await page.getByRole('button', { name: /catgirl-test/ }).first().click();
  await page.getByTestId('disable-catgirl-language-pack').click();
  await page.waitForFunction(() => document.documentElement.lang === 'zh');
  assert.equal(loadConfig().catgirlLanguagePackInstalled, false);
  assert.equal(loadConfig().catgirlPersonaEnabled, false);
  assert.equal(await page.evaluate(() => localStorage.getItem('tora_catgirl_language_pack')), '0');
  await page.reload({ waitUntil: 'domcontentloaded' });
  await input.waitFor({ state: 'visible' });
  assert.equal(await page.evaluate(() => document.documentElement.lang), 'zh');
  await page.getByRole('button', { name: /catgirl-test/ }).first().click();
  assert.equal(await page.getByTestId('disable-catgirl-language-pack').count(), 0);
  await page.getByRole('menuitem', { name: '语言', exact: true }).click();
  const languageModal = page.getByRole('dialog', { name: '选择语言' });
  await languageModal.waitFor({ state: 'visible' });
  assert.equal(await languageModal.getByRole('button', { name: /猫娘/ }).count(), 0);
  await page.keyboard.press('Escape');
  await input.fill('猫娘语');
  await dialog.waitFor({ state: 'visible' });
  await dialog.getByRole('button', { name: '暂时不要' }).click();
  await context.close();
  console.log('中文：精确暗号、IME、取消、失败重试、双语言解锁、开关保存与重载通过');

  saveConfig({ catgirlLanguagePackInstalled: false, catgirlPersonaEnabled: false });
  const jp = await open('ja');
  for (const text of ['喵喵喵', '猫娘语', 'これはにゃにゃにゃです']) { await jp.input.fill(text); assert.equal(await jp.page.getByRole('dialog').count(), 0); }
  for (const text of ['にゃにゃにゃ', '猫娘語']) {
    await jp.input.fill(text);
    const modal = jp.page.getByRole('dialog', { name: '猫娘言語パックを追加しますか？' });
    await modal.waitFor({ state: 'visible' });
    if (text === 'にゃにゃにゃ') await modal.getByRole('button', { name: '今はしない' }).click();
    else { await settleDialog(modal); await jp.page.screenshot({ path: join(output, 'ja-easter-egg.png') }); await modal.getByRole('button', { name: '言語パックを追加' }).click(); await modal.waitFor({ state: 'hidden' }); }
  }
  await jp.page.waitForFunction(() => document.documentElement.lang === 'ja-Neko');
  assert.match(await jp.input.getAttribute('placeholder'), /にゃ/);
  await jp.page.waitForFunction(() => [...document.querySelectorAll('.chat-greeting-character')].every(element => getComputedStyle(element).opacity === '1'));
  await jp.page.screenshot({ path: join(output, 'ja-catgirl-interface.png') });
  await jp.page.getByRole('button', { name: /catgirl-test/ }).first().click();
  await jp.page.getByTestId('disable-catgirl-language-pack').click();
  await jp.page.waitForFunction(() => document.documentElement.lang === 'ja');
  assert.equal(loadConfig().catgirlLanguagePackInstalled, false);
  await jp.input.fill('猫娘語');
  await jp.page.getByRole('dialog', { name: '猫娘言語パックを追加しますか？' }).getByRole('button', { name: '言語パックを追加' }).click();
  await jp.page.waitForFunction(() => document.documentElement.lang === 'ja-Neko');
  await preference(jp.page, 'en');
  await jp.page.getByRole('button', { name: /catgirl-test/ }).first().click();
  await jp.page.getByRole('menuitem', { name: 'Disable catgirl language pack' }).click();
  await jp.page.waitForFunction(() => document.documentElement.lang === 'ja');
  await preference(jp.page, 'en');
  for (const text of ['喵喵喵', '猫娘语', 'にゃにゃにゃ', '猫娘語']) { await jp.input.fill(text); assert.equal(await jp.page.getByRole('dialog').count(), 0); }
  await jp.context.close();
  // 尚未解锁的英文环境也不能触发，中文繁体环境能发现中文暗号。
  saveConfig({ catgirlLanguagePackInstalled: false, catgirlPersonaEnabled: false });
  const en = await open('en');
  for (const text of ['喵喵喵', '猫娘语', 'にゃにゃにゃ', '猫娘語']) { await en.input.fill(text); assert.equal(await en.page.getByRole('dialog').count(), 0); }
  await preference(en.page, 'zh-Hant');
  await en.input.fill('喵喵喵');
  await en.page.getByRole('dialog', { name: '是否添加猫娘语言包？' }).waitFor({ state: 'visible' });
  await en.page.getByRole('dialog', { name: '是否添加猫娘语言包？' }).getByRole('button', { name: '添加语言包' }).click();
  await en.page.waitForFunction(() => document.documentElement.lang === 'zh-Neko');
  await en.page.getByRole('button', { name: /catgirl-test/ }).first().click();
  await en.page.getByRole('menuitem', { name: '停用猫娘语言包' }).waitFor({ state: 'visible' });
  await en.page.screenshot({ path: join(output, 'zh-disable-menu.png') });
  await en.page.getByTestId('disable-catgirl-language-pack').click();
  await en.page.waitForFunction(() => document.documentElement.lang === 'zh-TW');
  await en.page.reload({ waitUntil: 'domcontentloaded' });
  await en.input.waitFor({ state: 'visible' });
  assert.equal(await en.page.evaluate(() => document.documentElement.lang), 'zh-TW');
  await en.context.close();
  assert.deepEqual(errors, []);
  console.log('日语双暗号、日语猫娘界面、英语限制和繁体中文触发通过；无页面脚本错误');
  console.log('停用菜单：失败保留状态、关闭人格、隐藏语言包、恢复简中/日语/繁中、重载及重新添加通过');
} finally {
  await browser.close(); server.closeAllConnections?.(); await new Promise(resolve => server.close(resolve));
  rmSync(home, { recursive: true, force: true });
}
