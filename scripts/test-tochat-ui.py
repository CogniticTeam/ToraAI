import json, os
from playwright.sync_api import sync_playwright
BASE=os.environ.get('TORA_TOCHAT_TEST_URL','http://127.0.0.1:3218')
OUT=os.environ.get('TORA_TOCHAT_TEST_OUTPUT','/private/tmp/tora-tochat-implementation-E29Tp9')
with sync_playwright() as p:
 browser=p.chromium.launch(headless=True,executable_path='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome')
 page=browser.new_page(viewport={'width':1440,'height':960},locale='zh-CN')
 errors=[];page.on('pageerror',lambda error:errors.append(str(error)))
 page.add_init_script('const base='+json.dumps(BASE)+''';localStorage.setItem('server_url',base);localStorage.setItem('username','mode-test');localStorage.setItem('tora_auth_token','tochat-test-login');localStorage.setItem('tora_auth_api','https://tora.ohfun.online');localStorage.setItem('tora_language_preference','zh');localStorage.setItem('tora:first-run:intro:v1','1');localStorage.setItem('tora:first-run:tour:v1','1');localStorage.setItem('tora:first-use-consent:v1',JSON.stringify({terms:true,privacy:true,crossBorder:true}));''')
 def cloud(route):
  path=route.request.url.split('ohfun.online',1)[1].split('?')[0]
  body={'id':1,'username':'mode-test'} if path=='/auth/me' else {'enabled':True,'chatRemaining':150,'workDailyRemaining':1000000,'workWeeklyRemaining':10000000} if path=='/tochat/quota' else {'models':[]} if path=='/models' else {'messages':[],'unread':0} if path=='/account/messages' else {}
  route.fulfill(status=200,content_type='application/json',body=json.dumps(body))
 page.route('https://tora.ohfun.online/**',cloud)
 page.route_web_socket('wss://tora.ohfun.online/account/events*',lambda socket:socket.send(json.dumps({'type':'ready'})))
 page.goto(BASE+'/tochat',wait_until='networkidle')
 page.get_by_text('随时可以开始。',exact=True).wait_for()
 assert page.locator('.composer-context').count()==0
 page.get_by_role('combobox',name='思考强度').select_option('max')
 page.locator('#tour-chat-textarea').fill('请回复一个短句')
 page.get_by_role('button',name='发送',exact=True).click()
 page.get_by_text('隔离链路已通过',exact=False).wait_for(timeout=20000)
 page.wait_for_timeout(500);page.screenshot(path=OUT+'/tochat-chat.png')
 page.get_by_role('button',name='工作',exact=True).click()
 page.get_by_text('我们要做什么？',exact=True).first.wait_for()
 page.wait_for_timeout(600)
 assert page.locator('.composer-context').count()==1
 page.screenshot(path=OUT+'/tochat-work.png')
 page.get_by_test_id('application-mode-switcher').click()
 page.get_by_role('menuitem').filter(has_text='ToCode').click()
 page.wait_for_url('**/chat/**');assert not page.locator('.tochat-tabs').count()
 assert not errors,errors
 print('Live ASAPI/SSE ToChat send, max effort, tool UI isolation, work workspace and ToCode switch passed.')
 browser.close()
