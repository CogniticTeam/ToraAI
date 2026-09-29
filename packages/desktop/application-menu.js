export function isTraditionalChineseLocale(language = '') {
  return /^zh(?:[-_](?:hant|tw|hk|mo))(?:[-_]|$)/i.test(language);
}

const traditionalLabels = {
  '关于 Tora': '關於 Tora', '检查更新…': '檢查更新…', '设置…': '設定…',
  '服务': '服務', '隐藏 Tora': '隱藏 Tora', '隐藏其他应用': '隱藏其他應用',
  '显示全部': '顯示全部', '退出 Tora': '退出 Tora', '文件': '檔案',
  '新任务': '新任務', '打开浏览器': '開啟瀏覽器', '关闭窗口': '關閉視窗',
  '编辑': '編輯', '撤销': '撤銷', '剪切': '剪下', '复制': '複製',
  '粘贴': '貼上', '粘贴并匹配样式': '貼上並符合樣式', '全选': '全選',
  '视图': '檢視', '实际大小': '實際大小', '切换全屏': '切換全螢幕',
  '模型设置…': '模型設定…', '自动化': '自動化',
  '打开日志文件夹': '開啟日誌資料夾', '窗口': '視窗',
  '缩放窗口': '縮放視窗', '全部置于前面': '全部移至最前方',
  '帮助': '說明', 'Tora 官网': 'Tora 官網', '下载最新版': '下載最新版本',
};

export function applicationMenuTemplate({ language = 'zh', isMac, send, checkUpdates, openWebsite, openDownloads, openLogs, about }) {
  const label = (zh, en) => isTraditionalChineseLocale(language)
    ? (traditionalLabels[zh] ?? zh) : language.startsWith('zh') ? zh : en;
  const command = (zh, en, action, accelerator) => ({ label: label(zh, en), accelerator, click: () => send(action) });
  const appItems = [
    { label: label('关于 Tora', 'About Tora'), click: about },
    { label: label('检查更新…', 'Check for Updates…'), click: checkUpdates },
    { type: 'separator' },
    command('设置…', 'Settings…', 'settings', 'CmdOrCtrl+,'),
    command('消息', 'Messages', 'messages', 'CmdOrCtrl+Shift+M'),
  ];
  return [
    ...(isMac ? [{ label: 'Tora', submenu: [...appItems,
      { type: 'separator' }, { label: label('服务', 'Services'), role: 'services' },
      { type: 'separator' }, { label: label('隐藏 Tora', 'Hide Tora'), role: 'hide' },
      { label: label('隐藏其他应用', 'Hide Others'), role: 'hideOthers' },
      { label: label('显示全部', 'Show All'), role: 'unhide' },
      { type: 'separator' }, { label: label('退出 Tora', 'Quit Tora'), role: 'quit' },
    ] }] : []),
    { label: label('文件', 'File'), submenu: [
      command('新任务', 'New Task', 'new-task', 'CmdOrCtrl+N'),
      command('打开浏览器', 'Open Browser', 'browser', 'CmdOrCtrl+Shift+B'),
      { type: 'separator' }, { label: label('关闭窗口', 'Close Window'), role: 'close' },
      ...(!isMac ? [...appItems, { label: label('退出 Tora', 'Quit Tora'), role: 'quit' }] : []),
    ] },
    { label: label('编辑', 'Edit'), submenu: [
      { label: label('撤销', 'Undo'), role: 'undo' }, { label: label('重做', 'Redo'), role: 'redo' },
      { type: 'separator' }, { label: label('剪切', 'Cut'), role: 'cut' },
      { label: label('复制', 'Copy'), role: 'copy' }, { label: label('粘贴', 'Paste'), role: 'paste' },
      { label: label('粘贴并匹配样式', 'Paste and Match Style'), role: 'pasteAndMatchStyle' },
      { label: label('全选', 'Select All'), role: 'selectAll' },
    ] },
    { label: label('视图', 'View'), submenu: [
      { label: label('放大', 'Zoom In'), role: 'zoomIn' }, { label: label('缩小', 'Zoom Out'), role: 'zoomOut' },
      { label: label('实际大小', 'Actual Size'), role: 'resetZoom' }, { type: 'separator' },
      { label: label('切换全屏', 'Toggle Full Screen'), role: 'togglefullscreen' },
    ] },
    { label: label('工具', 'Tools'), submenu: [
      command('模型设置…', 'Models…', 'models'), command('自动化', 'Automations', 'automations'),
      command('技能中心', 'Skills', 'skills'), command('消息', 'Messages', 'messages'),
      { type: 'separator' }, { label: label('打开日志文件夹', 'Open Logs Folder'), click: openLogs },
    ] },
    { label: label('窗口', 'Window'), submenu: [
      { label: label('最小化', 'Minimize'), role: 'minimize' }, { label: label('缩放窗口', 'Zoom Window'), role: 'zoom' },
      ...(isMac ? [{ type: 'separator' }, { label: label('全部置于前面', 'Bring All to Front'), role: 'front' }] : []),
    ] },
    { label: label('帮助', 'Help'), submenu: [
      { label: label('Tora 官网', 'Tora Website'), click: openWebsite },
      { label: label('下载最新版', 'Download Latest Version'), click: openDownloads },
      { label: label('检查更新…', 'Check for Updates…'), click: checkUpdates },
    ] },
  ];
}
