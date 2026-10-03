"""APIYI picker/add/edit flow with isolated server and mocked account API."""
import json
import os
from playwright.sync_api import sync_playwright

BASE = os.environ.get('TORA_APIYI_TEST_URL', 'http://127.0.0.1:3218')
OUT = os.environ.get('TORA_APIYI_TEST_OUTPUT', '/private/tmp/tora-apiyi-ML90vr')
models = []
saved = []
discoveries = []

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True, executable_path=os.environ.get('TORA_CHROME_PATH', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'))
    page = browser.new_page(viewport={'width':1440,'height':960}, locale='zh-CN')
    errors = []
    page.on('pageerror', lambda error: errors.append(str(error)))
    page.add_init_script('const testServerUrl = ' + json.dumps(BASE) + ';' + """{
      localStorage.setItem('server_url', testServerUrl);
      localStorage.setItem('username', 'APIYI test');
      localStorage.setItem('tora_auth_token', 'apiyi-ui-test-token');
      localStorage.setItem('tora_auth_api', 'https://tora.ohfun.online');
      localStorage.setItem('tora_language_preference', 'zh');
      localStorage.setItem('tora:first-run:intro:v1', '1');
      localStorage.setItem('tora:first-run:tour:v1', '1');
      localStorage.setItem('tora:first-use-consent:v1', JSON.stringify({terms:true,privacy:true,crossBorder:true}));
    }""")
    def cloud(route):
        path = route.request.url.split('ohfun.online',1)[1].split('?',1)[0]
        if path == '/auth/me': body = {'id':'test','username':'APIYI test'}
        elif path == '/models':
            if route.request.method == 'POST':
                payload = route.request.post_data_json
                saved.append(payload)
                for name in payload['models']:
                    models.append({'id':'apiyi-'+name,'provider':payload['provider'],'model':name,'label':payload['label'],'baseURL':payload['baseURL'],'apiKey':payload.get('apiKey'),'apiKeySet':True,'enabled':True,'vision':payload.get('vision')})
            body = {'models':models}
        elif path == '/account/events-ticket': body = {'ticket':'test-ticket'}
        elif path == '/account/messages': body = {'messages':[],'unread':0,'nextOffset':None}
        else: body = {}
        route.fulfill(status=200, content_type='application/json', body=json.dumps(body))
    page.route('https://tora.ohfun.online/**', cloud)
    page.route_web_socket('wss://tora.ohfun.online/account/events*', lambda socket: socket.send(json.dumps({'type':'ready'})))
    def list_models(route):
        discoveries.append(route.request.post_data_json)
        route.fulfill(status=200, content_type='application/json', body=json.dumps({'models':['gpt-5.4-mini','claude-sonnet-4-6']}))
    page.route(BASE+'/admin/models', list_models)
    page.goto(BASE, wait_until='networkidle')
    page.locator('#tour-llm-select').click()
    picker = page.locator('[data-slot="popover-content"]').filter(has_text='添加模型').last
    picker.get_by_role('button', name='添加模型', exact=True).click()
    page.get_by_text('模型管理', exact=True).wait_for()
    assert picker.is_hidden()
    page.get_by_role('button', name='添加模型', exact=True).click()
    provider = page.get_by_role('button', name='APIYI', exact=True)
    provider.wait_for()
    assert provider.locator('img').evaluate('(img)=>img.complete&&img.naturalWidth>0')
    page.wait_for_timeout(400)
    page.screenshot(path=OUT+'/apiyi-picker.png')
    provider.click()
    assert page.get_by_role('link', name='获取 API 密钥').get_attribute('href') == 'https://api.apiyi.com/token'
    page.locator('input[type=password]').fill('apiyi-ui-test-key-not-real')
    page.locator('input[type=password]').blur()
    page.get_by_text('gpt-5.4-mini', exact=True).first.wait_for()
    assert discoveries[-1] == {'baseURL':'https://api.apiyi.com/v1','apiKey':'apiyi-ui-test-key-not-real','provider':'apiyi'}
    page.get_by_text('gpt-5.4-mini', exact=True).first.click()
    page.get_by_text('claude-sonnet-4-6', exact=True).first.click()
    page.get_by_role('button', name='添加模型', exact=True).click()
    page.get_by_text('gpt-5.4-mini', exact=True).first.wait_for()
    assert saved[-1]['provider'] == 'apiyi'
    assert saved[-1]['baseURL'] == 'https://api.apiyi.com/v1'
    assert saved[-1]['models'] == ['gpt-5.4-mini','claude-sonnet-4-6']
    assert page.locator('body').inner_text().find('apiyi-ui-test-key-not-real') == -1
    page.get_by_role('button', name='编辑', exact=True).first.click()
    assert page.locator('input[type=password]').input_value() == ''
    page.wait_for_timeout(400)
    page.screenshot(path=OUT+'/apiyi-edit.png')
    assert not errors, errors
    print('APIYI UI verified: branded picker, key URL, discovery, batch save, local mirror and masked-key edit.')
    browser.close()
