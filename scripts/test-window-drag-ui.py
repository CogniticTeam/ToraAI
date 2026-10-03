"""Route coverage for native drag CSS and interactive exclusions (no paid API calls)."""
import json, os
from playwright.sync_api import sync_playwright, expect
BASE = 'http://127.0.0.1:3218'
with sync_playwright() as p:
    browser = p.chromium.launch(headless=True, executable_path='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome')
    page = browser.new_page(viewport={'width': 1440, 'height': 900}, locale='zh-CN')
    page.add_init_script('const base=' + json.dumps(BASE) + ''';localStorage.setItem('server_url',base);localStorage.setItem('username','drag-test');localStorage.setItem('tora_auth_token','fixture-token');localStorage.setItem('tora_auth_api','https://tora.ohfun.online');localStorage.setItem('tora_language_preference','zh');localStorage.setItem('tora:first-run:intro:v1','1');localStorage.setItem('tora:first-run:tour:v1','1');localStorage.setItem('tora:first-use-consent:v1',JSON.stringify({terms:true,privacy:true,crossBorder:true}));''')
    def cloud(route):
        path = route.request.url.split('ohfun.online', 1)[1].split('?')[0]
        data = {'id':1,'username':'drag-test'} if path == '/auth/me' else {'enabled':True,'chatRemaining':150,'workDailyRemaining':1000000,'workWeeklyRemaining':10000000} if path == '/tochat/quota' else {'models':[]} if path == '/models' else {'messages':[],'unread':0} if path == '/account/messages' else {'settings':{'enabled':False,'showEntry':False},'polls':[]}
        route.fulfill(status=200, content_type='application/json', body=json.dumps(data))
    page.route('https://tora.ohfun.online/**', cloud)
    page.route_web_socket('wss://tora.ohfun.online/account/events*', lambda socket: socket.send(json.dumps({'type':'ready'})))
    regions = []
    for route in ['/chat','/tochat','/schedule','/skill','/mcp','/browser','/polls','/channel','/credential','/knowledge']:
        page.goto(BASE + route, wait_until='domcontentloaded')
        expect(page.get_by_test_id('global-window-drag-region')).to_be_visible()
        page.wait_for_timeout(700)
        assert page.get_by_test_id('global-window-drag-region').evaluate("el=>getComputedStyle(el).getPropertyValue('-webkit-app-region')") == 'drag'
        info = page.locator('.app-drag').evaluate_all("els=>els.map(el=>({tag:el.tagName,rect:el.getBoundingClientRect().toJSON(),region:getComputedStyle(el).getPropertyValue('-webkit-app-region')})).filter(el=>el.rect.width>0&&el.rect.height>0)")
        assert info, route
        if route == '/tochat':
            expect(page.get_by_role('button', name='新对话', exact=True)).to_be_visible()
            assert page.get_by_role('button', name='新任务', exact=True).count() == 0
        elif route == '/chat':
            expect(page.get_by_role('button', name='新任务', exact=True)).to_be_visible()
        if route in ['/chat', '/tochat']:
            # Full content title bar, not only a narrow strip or middle spacer.
            header = page.locator('header[data-window-drag-region]') if route == '/tochat' else page.locator('[data-window-drag-region].h-12')
            expect(header).to_have_count(1)
            rect = header.bounding_box()
            assert rect['height'] == 48 and rect['width'] >= 1100, (route, rect)
        if route != '/polls': assert len(info) >= 2, (route, info)
        for control in page.locator('.app-drag button, .app-drag input, .app-drag textarea, .app-drag [role=tab]').all():
            assert control.evaluate("el=>getComputedStyle(el).getPropertyValue('-webkit-app-region')") == 'no-drag', route
        regions.append({'route':route,'regions':len(info)})
    page.goto(BASE + '/tochat', wait_until='networkidle')
    page.get_by_role('button', name='工作', exact=True).click()
    expect(page.get_by_role('button', name='工作', exact=True)).to_have_attribute('aria-pressed','true')
    expect(page.locator('#tour-workspace-picker')).to_be_visible()
    page.get_by_role('button', name='drag-test', exact=False).click()
    page.get_by_role('menuitem', name='设置', exact=True).click()
    expect(page.get_by_role('button',name='返回 Tora',exact=True)).to_be_visible()
    assert page.locator('[data-window-drag-region]').count() >= 2
    page.get_by_role('button', name='模型', exact=True).click()
    expect(page.locator('#tochat-model-source')).to_be_visible()
    page.get_by_role('button', name='返回 Tora', exact=True).click()
    print('PASS: top drag areas across 10 routes plus settings; controls excluded; mode/settings navigation still clickable.', json.dumps(regions))
    browser.close()
