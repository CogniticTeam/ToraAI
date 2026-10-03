"""Tests the real local ASAPI/SSE without production model calls."""
import json, os
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

BASE = os.environ.get('TORA_TOCHAT_TEST_URL', 'http://127.0.0.1:3218')
OUT = Path(os.environ['TORA_TOCHAT_TEST_OUTPUT'])
FIXTURE = Path(os.environ['TORA_HOME'])
with sync_playwright() as p:
    browser = p.chromium.launch(headless=True, executable_path='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome')
    page = browser.new_page(viewport={'width': 1440, 'height': 960}, locale='zh-CN')
    errors = []
    page.on('pageerror', lambda error: errors.append(str(error)))
    page.add_init_script('const base=' + json.dumps(BASE) + ''';localStorage.setItem('server_url',base);localStorage.setItem('username','mode-test');localStorage.setItem('tora_auth_token','tochat-test-login');localStorage.setItem('tora_auth_api','https://tora.ohfun.online');localStorage.setItem('tora_language_preference','zh');localStorage.setItem('tora:first-run:intro:v1','1');localStorage.setItem('tora:first-run:tour:v1','1');localStorage.setItem('tora:first-use-consent:v1',JSON.stringify({terms:true,privacy:true,crossBorder:true}));''')
    def cloud(route):
        path = route.request.url.split('ohfun.online', 1)[1].split('?')[0]
        body = {'id': 1, 'username': 'mode-test'} if path == '/auth/me' else {'enabled': True, 'chatRemaining': 150, 'workDailyRemaining': 1000000, 'workWeeklyRemaining': 10000000} if path == '/tochat/quota' else {'models': []} if path == '/models' else {'messages': [], 'unread': 0} if path == '/account/messages' else {}
        if path == '/models':
            body = {'models': [{'id': 'fixture-custom', 'provider': 'custom', 'model': 'fixture-vision', 'baseURL': 'https://fixture.test/v1', 'apiKey': 'fixture-custom-key', 'enabled': True, 'vision': True}]}
        route.fulfill(status=200, content_type='application/json', body=json.dumps(body))
    page.route('https://tora.ohfun.online/**', cloud)
    page.route_web_socket('wss://tora.ohfun.online/account/events*', lambda socket: socket.send(json.dumps({'type': 'ready'})))
    page.goto(BASE + '/chat', wait_until='networkidle')
    page.locator('#tour-chat-textarea').wait_for()
    page.wait_for_timeout(400)
    original = page.locator('#tour-chat-input').bounding_box()
    original_column = page.locator('.canvas-glow > div').bounding_box()
    original_style = page.locator('#tour-chat-input').evaluate('(el)=>{const s=getComputedStyle(el);return [s.borderRadius,s.padding,s.minHeight]}')
    assert page.locator('.composer-context').count() == 1
    page.get_by_test_id('application-mode-switcher').click()
    page.get_by_role('menuitem').filter(has_text='ToChat').click()
    page.get_by_role('heading', name='随时可以开始。', exact=True).first.wait_for()
    expect(page.get_by_test_id('tochat-page')).to_have_count(1)
    assert page.locator('.composer-context').count() == 0
    assert page.get_by_role('button', name='联网搜索', exact=True).count() == 0
    assert page.get_by_role('button', name='优化提示词', exact=True).count() == 0
    expect(page.get_by_test_id('official-deepseek-logo')).to_be_visible()
    capsule = page.locator('#tour-chat-input')
    expect(capsule).to_have_attribute('data-composer-variant', 'capsule')
    page.wait_for_timeout(250)
    chat_box = capsule.bounding_box()
    assert chat_box['height'] <= 60 and chat_box['height'] < original['height'] - 20, (chat_box, original)
    assert capsule.evaluate('el=>parseFloat(getComputedStyle(el).borderRadius)') > 100
    editor = page.locator('#tour-chat-textarea').bounding_box()
    send_rect = page.get_by_role('button', name='发送', exact=True).bounding_box()
    assert abs(editor['y'] + editor['height']/2 - send_rect['y'] - send_rect['height']/2) <= 3
    page.screenshot(path=str(OUT / 'empty-chat-capsule.png'))
    page.locator('#tour-chat-textarea').fill('多行输入测试')
    page.locator('#tour-chat-textarea').press('Shift+Enter')
    page.locator('#tour-chat-textarea').press('Shift+Enter')
    assert capsule.bounding_box()['height'] > chat_box['height']
    assert capsule.evaluate('el=>parseFloat(getComputedStyle(el).borderRadius)') == 24
    page.locator('#tour-chat-textarea').fill('')
    assert capsule.bounding_box()['height'] <= 60
    page.get_by_role('button', name='思考强度', exact=True).click()
    page.get_by_role('menuitemradio', name='最大', exact=True).click()
    page.locator('input[type=file]').set_input_files('/Users/zhenxun/Tora/packages/desktop/frontend/src/assets/providers/site-apiyi.png')
    page.locator('#tour-chat-textarea').fill('请回复一个短句')
    page.get_by_role('button', name='发送', exact=True).click()
    page.get_by_text('隔离链路已通过', exact=False).wait_for(timeout=20000)
    expect(page.get_by_role('button', name='发送', exact=True)).to_be_disabled()
    chat_url = page.url
    expect(page.locator('[data-slot="message-scroller"]')).to_have_count(1)
    message_column = page.locator('[data-slot="message-scroller"]').bounding_box()
    assert abs(message_column['x'] - original_column['x']) <= 1, (message_column, original_column)
    assert abs(message_column['width'] - original_column['width']) <= 1, (message_column, original_column)
    assert message_column['x'] >= 400 and message_column['x'] + message_column['width'] <= 1320
    page.screenshot(path=str(OUT / 'chat.png'))
    req = json.loads((FIXTURE / 'requests.json').read_text())[0]
    assert req['official'] and req['mode'] == 'chat' and req['body']['reasoning_effort'] == 'max'
    assert any(isinstance(m.get('content'), list) and any(b['type'] == 'image_url' for b in m['content']) for m in req['body']['messages'])
    assert sorted(t['function']['name'] for t in req['body']['tools']) == ['WebFetch','WebSearch']
    assert req['body']['tool_choice'] == 'auto'
    # A restored conversation has a permanent SSE connection, so networkidle is not applicable.
    page.reload(wait_until='load')
    assert page.get_by_role('button', name='联网搜索', exact=True).count() == 0
    indicator = page.get_by_test_id('tochat-task-indicator')
    expect(indicator).to_have_attribute('data-motion', 'standard')
    start_x = indicator.bounding_box()['x']
    page.evaluate('''() => {
        window.tabMotionSamples = [];
        const until = performance.now() + 850;
        const sample = () => {
            const indicators = document.querySelectorAll('[data-testid="tochat-task-indicator"]');
            const el = indicators[indicators.length - 1];
            if (el) window.tabMotionSamples.push(el.getBoundingClientRect().x);
            if (performance.now() < until) requestAnimationFrame(sample);
        };
        requestAnimationFrame(sample);
    }''')
    page.get_by_role('button', name='工作', exact=True).click()
    page.get_by_role('heading', name='我们要做什么？', exact=True).first.wait_for()
    expect(page.get_by_test_id('tochat-page')).to_have_count(1)
    page.wait_for_timeout(400)
    end_x = page.get_by_test_id('tochat-task-indicator').bounding_box()['x']
    samples = page.evaluate('window.tabMotionSamples')
    assert end_x > start_x + 10 and any(start_x + 1 < x < end_x - 1 for x in samples), (start_x, end_x, samples)
    print(f'Tab indicator moved smoothly from {start_x:.1f} to {end_x:.1f}; sampled {len(samples)} animation frames.')
    page.evaluate("localStorage.setItem('tora.motion.mode','off');window.dispatchEvent(new Event('tora:motion-changed'))")
    expect(page.get_by_test_id('tochat-task-indicator')).to_have_attribute('data-motion', 'off')
    page.evaluate("localStorage.setItem('tora.motion.mode','system');window.dispatchEvent(new Event('tora:motion-changed'))")
    work = page.locator('#tour-chat-input').bounding_box()
    work_style = page.locator('#tour-chat-input').evaluate('(el)=>{const s=getComputedStyle(el);return [s.borderRadius,s.padding,s.minHeight]}')
    expect(page.locator('#tour-chat-input')).to_have_attribute('data-composer-variant', 'default')
    assert abs(work['width'] - original['width']) <= 1 and abs(work['height'] - original['height']) <= 1, (original, work)
    assert original_style == work_style
    assert page.locator('.composer-context').count() == 1
    assert page.get_by_role('button', name='优化提示词', exact=True).count() == 0
    page.locator('#tour-workspace-picker').click()
    page.get_by_role('button').filter(has_text=str(FIXTURE / 'workspace')).click()
    page.get_by_role('button', name='手动审批', exact=True).click()
    page.get_by_role('menuitemradio').filter(has_text='自动审批').click()
    page.locator('#tour-chat-textarea').fill('写入验证文件')
    page.get_by_role('button', name='发送', exact=True).click()
    page.get_by_text('工作执行已通过', exact=False).first.wait_for(timeout=20000)
    assert (FIXTURE / 'workspace/work-probe.txt').read_text() == 'work tool verified'
    expect(page.get_by_test_id('tochat-page')).to_have_count(1)
    work_url = page.url
    page.screenshot(path=str(OUT / 'work.png'))
    page.get_by_role('button', name='官方模型额度', exact=True).click()
    expect(page.get_by_text('聊天：150 / 150 条（日）', exact=True)).to_be_visible()
    expect(page.get_by_text('工作：10,000,000 / 1000 万 Token（周）', exact=True)).to_be_visible()
    page.keyboard.press('Escape')
    page.get_by_test_id('application-mode-switcher').click()
    page.get_by_role('menuitem').filter(has_text='ToCode').click()
    page.wait_for_url('**/chat/**')
    assert page.get_by_test_id('tochat-page').count() == 0
    assert page.get_by_role('button', name='写入验证文件', exact=True).count() == 0
    page.wait_for_timeout(800)
    page.screenshot(path=str(OUT / 'tocode.png'))
    page.get_by_role('button', name='mode-test', exact=False).click()
    page.get_by_role('menuitem', name='设置', exact=True).click()
    page.get_by_role('button', name='模型', exact=True).click()
    page.locator('#tochat-model-source').select_option('custom')
    page.get_by_role('button', name='返回 Tora', exact=True).click()
    page.get_by_test_id('application-mode-switcher').click()
    page.get_by_role('menuitem').filter(has_text='ToChat').click()
    expect(page.get_by_test_id('tochat-page')).to_have_count(1)
    expect(page.get_by_role('button', name='官方模型额度', exact=True)).to_contain_text('自定义模型')
    assert page.get_by_role('button', name='思考强度', exact=True).count() == 0
    expect(page.locator('#tour-model-selector')).to_be_visible()
    page.locator('#tour-model-selector').click()
    page.get_by_role('button').filter(has_text='fixture-vision').first.click()
    page.keyboard.press('Escape')
    page.locator('#tour-chat-textarea').fill('自定义模型发送测试')
    page.get_by_role('button', name='发送', exact=True).click()
    page.get_by_text('隔离链路已通过', exact=False).wait_for(timeout=20000)
    custom_request = json.loads((FIXTURE / 'requests.json').read_text())[-1]
    assert not custom_request['official'] and custom_request['body']['model'] == 'fixture-vision'
    page.goto(chat_url, wait_until='load')
    expect(page.get_by_test_id('tochat-page')).to_have_count(1)
    expect(page.get_by_role('button', name='思考强度', exact=True)).to_be_visible()
    page.goto(work_url, wait_until='load')
    expect(page.get_by_test_id('tochat-page')).to_have_count(1)
    expect(page.get_by_role('button', name='工作', exact=True)).to_have_attribute('aria-pressed', 'true')
    page.set_viewport_size({'width': 960, 'height': 720})
    page.emulate_media(reduced_motion='reduce', color_scheme='dark')
    expect(page.get_by_test_id('tochat-task-indicator')).to_have_attribute('data-motion', 'off')
    page.evaluate("document.documentElement.classList.add('dark')")
    page.wait_for_timeout(500)
    assert page.evaluate('document.documentElement.scrollWidth <= document.documentElement.clientWidth')
    composer = page.locator('#tour-chat-input').bounding_box()
    send_button = page.get_by_role('button', name='发送', exact=True).bounding_box()
    assert send_button['x'] + send_button['width'] <= composer['x'] + composer['width'] + 1
    page.screenshot(path=str(OUT / 'work-dark-960.png'))
    page.goto(chat_url, wait_until='load')
    expect(page.get_by_test_id('tochat-page')).to_have_count(1)
    expect(page.locator('#tour-chat-input')).to_have_attribute('data-composer-variant', 'capsule')
    page.locator('#tour-chat-textarea').fill('这是窄窗口长文本测试。' * 20)
    assert page.locator('#tour-chat-textarea').input_value() == '这是窄窗口长文本测试。' * 20
    page.locator('#tour-chat-textarea').fill('')
    assert page.locator('#tour-chat-input').bounding_box()['height'] <= 60
    assert page.evaluate('document.documentElement.scrollWidth <= document.documentElement.clientWidth')
    page.screenshot(path=str(OUT / 'chat-dark-960.png'))
    assert not errors, errors
    print('PASS: capsule/default geometry; mode routing/history; DeepSeek logo; removed optimizer/search buttons; automatic web tools; image/max/SSE; actual workspace Write tool; quota; model source settings.')
    browser.close()
