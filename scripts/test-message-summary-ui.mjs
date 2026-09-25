import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
process.env.COCODE_HOME = mkdtempSync(join(tmpdir(), 'cocode-message-summary-'));
const { startASAPIServer } = await import('../packages/core/src/asapi/server.js');
const server = await startASAPIServer({ port: 0 });
const base = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
const title = '关于关闭官方模型的通知';
const body = '由于不可抗力因素，CoCode暂不接受任何充值与订阅，官方模型已全部下架。感谢你的支持与理解，我们未来可能会在2027年上半年重新开放。'.repeat(12) + '\n\n' + 'https://example.invalid/' + 'a'.repeat(900);
try {
  for (const width of [1230,390]) {
    const page=await browser.newPage({viewport:{width:1230,height:850},locale:'zh-CN',colorScheme:'dark'});
    let read = false; const errors=[];page.on('pageerror',e=>errors.push(e.message));
    await page.addInitScript(({base})=>{
      for(const [k,v] of Object.entries({server_url:base,username:'cocode',cocode_auth_token:'mock-token',cocode_auth_username:'SummaryTest',cocode_cn_notice_agreed_v1:'1',cocode_language_preference:'zh',theme:'dark'}))localStorage.setItem(k,v);
    },{base});
    await page.route('https://cocode.ohfun.online/**',route=>{
      const path=new URL(route.request().url()).pathname;
      const json=(data,status=200)=>route.fulfill({status,contentType:'application/json',body:JSON.stringify(data)});
      if(path==='/auth/me')return json({username:'SummaryTest',email:'test@example.invalid',banned:false});
      if(path==='/account/messages/read'){read=true;return json({ok:true});}
      if(path==='/account/messages')return json({messages:[{id:'summary',title,body,created_at:new Date().toISOString(),read_at:read?'read':null,source_language:'zh'}],unread:read?0:1,nextOffset:null});
      if(path==='/models')return json({models:[]});
      return json({},503);
    });
    await page.goto(base);
    await page.getByRole('button',{name:/SummaryTest/}).click();
    await page.getByRole('menuitem',{name:/消息/}).click();
    await page.setViewportSize({width,height:850});
    const dialog=page.getByRole('dialog');
    const row=dialog.getByRole('button',{name:new RegExp(title)});
    await row.waitFor();
    assert.equal(read,false);
    const summary=await row.locator('p').textContent();
    assert.ok(Array.from(summary).length<=81&&summary.endsWith('…'));
    assert.equal(await dialog.getByRole('button',{name:'无需翻译'}).count(),0);
    async function assertNoOverflow() {
      const geometry=await dialog.evaluate(el=>({scroll:el.scrollWidth,width:el.clientWidth,left:el.getBoundingClientRect().left,right:el.getBoundingClientRect().right}));
      assert.ok(geometry.scroll<=geometry.width+1,JSON.stringify(geometry));
      assert.ok(geometry.left>=0&&geometry.right<=width,JSON.stringify(geometry));
    }
    await assertNoOverflow();
    await page.screenshot({path:`/private/tmp/cocode-message-summary-${width}.png`});
    await row.focus();await page.keyboard.press('Enter');
    await dialog.getByRole('heading',{name:'消息详情',exact:true}).waitFor();
    assert.equal(await dialog.locator('article > p').textContent(),body);
    assert.equal(read,true);
    await assertNoOverflow();
    await dialog.getByRole('button',{name:/返回消息列表/}).click();
    await row.waitFor();await assertNoOverflow();
    assert.deepEqual(errors,[]);
    console.log(`通过 ${width}px：短摘要、整条点击/键盘进入详情、完整正文、返回、标记已读、长链接无横向溢出。`);
    await page.close();
  }
} finally {await browser.close();server.close();}
