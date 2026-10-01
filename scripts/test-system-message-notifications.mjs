import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';

import { createAccountMessageNotification } from '../packages/desktop/message-notifications.js';

class FakeNotification extends EventEmitter {
  static supported = true;
  static isSupported() { return this.supported; }
  constructor(options) { super(); this.options = options; this.shown = false; }
  show() { this.shown = true; }
}

function windowFixture() {
  const calls = [];
  const window = {
    destroyed: false, focused: false, minimized: true,
    isDestroyed() { return this.destroyed; },
    isFocused() { return this.focused; },
    isMinimized() { return this.minimized; },
    restore() { calls.push('restore'); this.minimized = false; },
    show() { calls.push('show'); },
    focus() { calls.push('focus'); },
    webContents: { send(channel) { calls.push(channel); } },
  };
  return { window, calls };
}

test('后台新消息生成不含正文的系统通知，点击后恢复窗口并打开消息', () => {
  const { window, calls } = windowFixture();
  const notice = createAccountMessageNotification({ Notification: FakeNotification, window, language: 'zh' });
  assert.deepEqual(notice.options, { title: 'Tora', body: '收到一条 Tora 消息' });
  notice.show();
  assert.equal(notice.shown, true);
  notice.emit('click');
  assert.deepEqual(calls, ['restore', 'show', 'focus', 'notifications:open-messages']);
  assert.equal(createAccountMessageNotification({ Notification: FakeNotification, window, language: 'en' }).options.body, 'You have a new message');
  assert.equal(createAccountMessageNotification({ Notification: FakeNotification, window, language: 'zh-Hant' }).options.body, '收到一則 Tora 訊息');
});

test('前台同样可请求系统通知；已销毁窗口和不支持通知的系统不发送', () => {
  const { window } = windowFixture();
  window.focused = true;
  assert.ok(createAccountMessageNotification({ Notification: FakeNotification, window }));
  window.focused = false; window.destroyed = true;
  assert.equal(createAccountMessageNotification({ Notification: FakeNotification, window }), null);
  window.destroyed = false; FakeNotification.supported = false;
  assert.equal(createAccountMessageNotification({ Notification: FakeNotification, window }), null);
  FakeNotification.supported = true;
});
