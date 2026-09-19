// headless 浏览器冒烟测试：加载 Vega 前端，预置 localStorage，验证聊天页渲染
// 运行：node scripts/test-ui-headless.mjs
import { createRequire } from 'node:module';
const require = createRequire('/Users/zhenxun/.workbuddy/binaries/node/workspace/package.json');
const { chromium } = require('playwright-core');

const BASE = 'http://127.0.0.1:3210';
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const shots = [];
const out = [];

async function main() {
  const browser = await chromium.launch({
    headless: true,
    executablePath: CHROME,
    args: ['--no-sandbox', '--disable-gpu']
  });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const logs = [];
  page.on('console', (m) => { if (m.type() === 'error') logs.push(m.text().slice(0, 200)); });
  page.on('pageerror', (e) => logs.push('PAGEERROR: ' + String(e).slice(0, 200)));

  // 1. setup 页已移除，直接进主应用；首次注入 localStorage 再 reload
  await page.goto(BASE + '/', { waitUntil: 'commit', timeout: 10000 });
  await page.evaluate((base) => {
    if (!localStorage.getItem('server_url')) {
      localStorage.setItem('server_url', base);
      localStorage.setItem('username', 'jason');
    }
  }, BASE);
  await page.reload({ waitUntil: 'commit', timeout: 10000 });
  await page.waitForSelector('textarea', { timeout: 15000 });
  await page.waitForTimeout(2500);
  await page.screenshot({ path: '/tmp/vega-shot-1-home.png' });
  shots.push('主应用');
  await page.screenshot({ path: '/tmp/vega-shot-2-chat.png' });
  shots.push('聊天主页');

  // 3. 校验侧栏 agent 与新建会话按钮存在
  const agentName = await page.evaluate(() => document.body.innerText.includes('Vega'));
  out.push(`侧栏包含默认 Agent "Vega": ${agentName}`);

  // 4. 点击新建会话
  const newBtns = await page.getByRole('button').all();
  let clicked = false;
  for (const b of newBtns) {
    const t = (await b.innerText().catch(() => '')).trim();
    if (t.includes('新会话') || t.includes('New')) { await b.click(); clicked = true; break; }
  }
  await page.waitForTimeout(1200);
  await page.screenshot({ path: '/tmp/vega-shot-3-newsession.png' });
  shots.push('新建会话后');
  out.push(`点击新建会话: ${clicked}`);

  // 5. 输入框是否渲染
  const hasInput = await page.evaluate(() => !!document.querySelector('textarea'));
  out.push(`消息输入框渲染: ${hasInput}`);

  // 6. 打开设置窗口（点侧栏底部"设置"按钮）
  await page.getByRole('button', { name: /设置/ }).first().click({ timeout: 5000 }).catch(() => {});
  await page.waitForTimeout(600);
  const settingsVisible = await page.evaluate(() => document.body.innerText.includes('数据管理'));
  await page.screenshot({ path: '/tmp/vega-shot-4-settings.png' });
  shots.push('设置窗口');
  out.push(`设置窗口打开: ${settingsVisible}`);
  // 关闭
  await page.keyboard.press('Escape').catch(() => {});
  await page.locator('button[aria-label="关闭"]').click({ timeout: 2000 }).catch(() => {});

  await browser.close();
  console.log(out.join('\n'));
  console.log('截图: ' + shots.map((s, i) => `${s}=/tmp/vega-shot-${i + 1}-*.png`).join(', '));
  if (logs.length) {
    console.log('\n页面错误（前10条）:');
    logs.slice(0, 10).forEach((l) => console.log(' -', l));
  } else {
    console.log('\n无页面错误 ✓');
  }
}
main().catch((e) => { console.error('失败:', e.message); process.exit(1); });
