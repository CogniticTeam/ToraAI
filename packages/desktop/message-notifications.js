// 系统通知只包含固定文案；用户消息正文和标题绝不经过 IPC 或锁屏通知。
import { nativeText, normalizeNativeLanguage } from './native-i18n.js';

export function createAccountMessageNotification({ Notification, window, language = 'zh' }) {
  if (!window || window.isDestroyed() || !Notification.isSupported()) return null;
  const notice = new Notification({
    title: 'Tora',
    body: normalizeNativeLanguage(language) === 'zh-Hant' ? '收到一則 Tora 訊息'
	  : normalizeNativeLanguage(language) === 'zh' ? '收到一条 Tora 消息'
	  : nativeText(language, 'You have a new message'),
  });
  notice.on('click', () => {
    if (window.isDestroyed()) return;
    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();
    window.webContents.send('notifications:open-messages');
  });
  return notice;
}
