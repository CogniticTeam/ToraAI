const SYSTEM_NOTIFICATIONS_KEY = 'tora:system-message-notifications:v1';

export function systemMessageNotificationsEnabled(): boolean {
  try { return localStorage.getItem(SYSTEM_NOTIFICATIONS_KEY) !== '0'; }
  catch { return true; }
}

export function setSystemMessageNotificationsEnabled(enabled: boolean): void {
  try { localStorage.setItem(SYSTEM_NOTIFICATIONS_KEY, enabled ? '1' : '0'); }
  catch { /* 无存储时仅本次界面状态生效。 */ }
}
