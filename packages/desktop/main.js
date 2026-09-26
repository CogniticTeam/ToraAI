// CoCode 桌面版主进程：启动本地 ASAPI 服务（agentscope 前端协议），加载构建好的前端
// 渲染层无任何 Node 集成（contextIsolation 默认开启）；前端通过 127.0.0.1 HTTP/SSE 通信，
// 与浏览器打开完全同构。preload 在页面脚本执行前预置本地服务连接，首屏只加载一次。
import { app, BrowserWindow, dialog, ipcMain, Menu, nativeTheme, net, safeStorage, session, shell, systemPreferences } from 'electron';
import electronUpdater from 'electron-updater';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { voiceStatus, setAsrApiKey, transcribeSamples } from './voice.js';
import { optimizePrompt } from './prompt-optimizer.js';
import { isAppUrl, normalizeExternalHttpUrl } from './navigation-security.js';
import { applicationMenuTemplate } from './application-menu.js';

app.setName('CoCode');

const __dirname = dirname(fileURLToPath(import.meta.url));

// 解除 Chromium 的 60/120 FPS 软件上限与垂直同步限制，让 CSS 动画、滚动和
// Canvas 可以按设备与 GPU 能力运行，不被 Electron 固定在显示器刷新率。开关必须
// 在 app ready 之前设置；backgroundThrottling 则在窗口级继续保证失焦后不降频。
for (const chromiumSwitch of [
  'disable-frame-rate-limit',
  'disable-gpu-vsync',
  'disable-renderer-backgrounding',
]) {
  if (!app.commandLine.hasSwitch(chromiumSwitch)) {
    app.commandLine.appendSwitch(chromiumSwitch);
  }
}

// 打包后的 core 被放入 resources/core；开发态仍直接加载工作区的 packages/core。
// 这样安装包不会依赖 app.asar 外的相对路径，且本地 `electron .` 调试保持不变。
const coreRoot = app.isPackaged ? join(process.resourcesPath, 'core') : join(__dirname, '..', 'core');
const [{ startASAPIServer, setDesktopAccessBlocked }, { clearBrowserDriver, setBrowserDriver }, { setWebFetcher }] = await Promise.all([
  import(pathToFileURL(join(coreRoot, 'src', 'asapi', 'server.js')).href),
  import(pathToFileURL(join(coreRoot, 'src', 'tools', 'browser.js')).href),
  import(pathToFileURL(join(coreRoot, 'src', 'tools', 'web.js')).href),
]);
const { autoUpdater } = electronUpdater;

let win = null;
let serverUrl = '';

// preload 在页面脚本运行前同步读取 Electron 解析后的系统区域设置，供首次语言选择。
ipcMain.on('app:get-system-locale', (event) => {
  event.returnValue = app.getLocale();
});
ipcMain.on('app:get-version', (event) => {
  event.returnValue = app.getVersion();
});

// macOS 和 Windows 均由 electron-updater 下载、校验并安装 GitHub Release。
// macOS 更新元数据不可用时，再通过公开 Release 检测新版并提供官网下载兜底。
const RELEASES_API_URL = 'https://api.github.com/repos/CoCodeAgent/CoCode/releases/latest';
const OFFICIAL_DOWNLOAD_URL = 'https://ohfun.online/#download';
const UPDATE_INTERVAL_MS = 6 * 60 * 60 * 1000;
let updaterReady = false;
let updateCheckPromise = null;
let updateChecksScheduled = false;
let requiredUpdate = null;

function observeUpdateDownload(result) {
  // checkForUpdates 启动后台下载后立即返回；订阅 Promise 防止网络错误成为未处理拒绝。
  if (result?.downloadPromise) void result.downloadPromise.catch((error) => {
    console.warn('[updater] Background download failed:', error?.message || error);
    if (requiredUpdate?.status === 'downloading') publishRequiredUpdate({ status: 'error' });
  });
}

function publishRequiredUpdate(patch) {
  requiredUpdate = { ...requiredUpdate, ...patch };
  setDesktopAccessBlocked('update', '请更新 CoCode 后继续使用');
  if (win && !win.isDestroyed()) win.webContents.send('updates:required', requiredUpdate);
}
function clearRequiredUpdate() {
  if (!requiredUpdate) return;
  requiredUpdate = null;
  setDesktopAccessBlocked('update', '');
  if (win && !win.isDestroyed()) win.webContents.send('updates:required', null);
}
ipcMain.on('updates:state', event => { event.returnValue = requiredUpdate; });
ipcMain.handle('updates:action', async (_event, action) => {
  if (!requiredUpdate) return;
  if (action === 'download') return openSafeExternal(OFFICIAL_DOWNLOAD_URL);
  if (action === 'quit') return app.quit();
  if (action === 'install' && requiredUpdate.status === 'ready' && ['darwin', 'win32'].includes(process.platform)) {
    autoUpdater.quitAndInstall(false, true);
  }
  if (action === 'retry' && requiredUpdate.status === 'error' && ['darwin', 'win32'].includes(process.platform)) {
    publishRequiredUpdate({ status: 'downloading', percent: 0 });
    try {
      const result = await autoUpdater.checkForUpdates();
      observeUpdateDownload(result);
      if (!result?.isUpdateAvailable) clearRequiredUpdate();
    }
    catch { publishRequiredUpdate({ status: 'error' }); }
  }
});

async function openSafeExternal(rawUrl) {
  let url;
  try {
    url = normalizeExternalHttpUrl(rawUrl);
  } catch (error) {
    console.warn('[navigation] Blocked external URL:', error instanceof Error ? error.message : error);
    return false;
  }
  try {
    await shell.openExternal(url);
    return true;
  } catch (error) {
    console.warn('[navigation] Failed to open external URL:', error instanceof Error ? error.message : error);
    return false;
  }
}

function compareVersions(left, right) {
  const parts = (version) => String(version || '')
    .replace(/^v/i, '')
    .split('-', 1)[0]
    .split('.')
    .map((part) => Number.parseInt(part, 10) || 0);
  const a = parts(left);
  const b = parts(right);
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    if ((a[i] || 0) !== (b[i] || 0)) return (a[i] || 0) > (b[i] || 0) ? 1 : -1;
  }
  return 0;
}

async function checkMacForUpdateFallback() {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);
  let response;
  try {
    response = await fetch(RELEASES_API_URL, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': `CoCode/${app.getVersion()}` },
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }
  if (!response.ok) throw new Error(`更新服务返回 ${response.status}`);
  const release = await response.json();
  const version = String(release.tag_name || release.name || '').replace(/^v/i, '');
  if (release.draft || release.prerelease) return { status: 'up-to-date', currentVersion: app.getVersion() };
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('更新服务返回的版本号无效');
  if (!version || compareVersions(version, app.getVersion()) <= 0) {
    return { status: 'up-to-date', currentVersion: app.getVersion() };
  }
  return { status: 'available', version, url: OFFICIAL_DOWNLOAD_URL, currentVersion: app.getVersion() };
}

function setupUpdater() {
  if (!['darwin', 'win32'].includes(process.platform) || !app.isPackaged || updaterReady) return;
  updaterReady = true;
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = false;
  autoUpdater.on('error', (error) => {
    console.warn('[updater] Update failed:', error?.message || error);
    if (requiredUpdate) publishRequiredUpdate({ status: 'error' });
  });
  autoUpdater.on('update-available', info => publishRequiredUpdate({ version: info.version, status: 'downloading', percent: 0, platform: process.platform }));
  autoUpdater.on('download-progress', progress => publishRequiredUpdate({ status: 'downloading', percent: Math.round(progress.percent) }));
  autoUpdater.on('update-downloaded', info => publishRequiredUpdate({ version: info.version, status: 'ready', percent: 100, platform: process.platform }));
}

async function checkDesktopForUpdate() {
  setupUpdater();
  if (!updaterReady) return { status: 'unavailable' };
  const result = await autoUpdater.checkForUpdates();
  observeUpdateDownload(result);
  if (!result?.isUpdateAvailable) {
    clearRequiredUpdate();
    return { status: 'up-to-date', currentVersion: app.getVersion() };
  }
  // autoDownload=true：后台下载完成后由 update-downloaded 提示重启安装。
  return { status: 'downloading', version: result.updateInfo?.version || '' };
}

async function checkForUpdates() {
  if (!app.isPackaged) return { status: 'development' };
  if (requiredUpdate && ['downloading', 'ready'].includes(requiredUpdate.status)) {
    return { status: requiredUpdate.status, version: requiredUpdate.version };
  }
  if (updateCheckPromise) return updateCheckPromise;
  updateCheckPromise = (async () => {
    try {
      if (['darwin', 'win32'].includes(process.platform)) return await checkDesktopForUpdate();
      return { status: 'unavailable' };
    } catch (error) {
      console.warn('[updater] Check failed:', error?.message || error);
      if (process.platform === 'darwin') {
        try {
          const fallback = await checkMacForUpdateFallback();
          if (fallback.status === 'available') {
            publishRequiredUpdate({ version: fallback.version, status: 'error', platform: 'darwin' });
            return fallback;
          }
        } catch (fallbackError) {
          console.warn('[updater] macOS fallback check failed:', fallbackError?.message || fallbackError);
        }
      }
      return { status: 'error', message: error instanceof Error ? error.message : String(error) };
    } finally {
      updateCheckPromise = null;
    }
  })();
  return updateCheckPromise;
}

function scheduleUpdateChecks() {
  if (!app.isPackaged || process.platform === 'linux' || updateChecksScheduled) return;
  updateChecksScheduled = true;
  void checkForUpdates();
  setInterval(() => { void checkForUpdates(); }, UPDATE_INTERVAL_MS).unref();
}

ipcMain.handle('updates:check', () => checkForUpdates());

// 窗口原生背景 = 「加载页」：首帧渲染前用户看到的就是这块底色，必须跟深浅色。
// 取值与前端 index.css 的 --bg 保持一致（浅 #f4f5f6 / 深 #0c0d10），转场无缝。
// 取值优先级（高 → 低）：
//   1. 上次会话渲染层上报的主题（userData/theme-cache.json）—— 主进程读不到
//      localStorage，但用户在应用内固定过的主题值得跨启动记住，二次启动零偏差；
//   2. 系统主题（nativeTheme）—— 首次启动 / 从未上报过时的最优猜测，与
//      index.html 内联脚本的 system 分支判断一致；
//   3. 渲染层主题就绪后上报实际深浅（win:set-background）—— 以渲染层为准，
//      并持久化进缓存供下次启动用。此后系统主题再变化沿用上报值，
//      避免把用户固定的主题冲掉。
const THEME_CACHE_FILE = () => join(app.getPath('userData'), 'theme-cache.json');
const readCachedDark = () => {
  try { return JSON.parse(readFileSync(THEME_CACHE_FILE(), 'utf8')).dark === true; }
  catch { return null; }
};
let reportedDark = null;
const winBackgroundFor = (dark) => (dark ? '#0c0d10' : '#f4f5f6');

/**
 * 安装自定义应用菜单，替掉 Electron 默认菜单。
 *
 * 目的：禁止 ⌘R / Ctrl+R「重新载入页面」。默认菜单的视图项里有 reload
 * （⌘R/Ctrl+R）和 forceReload（⇧⌘R/Ctrl+Shift+R），误按会把整个应用重刷，
 * 打断正在跑的任务。macOS 下菜单快捷键在原生层就被消费，渲染层或
 * before-input-event 都拦不住，只能从菜单模板上把这两个 role 去掉。
 * 其余标准快捷键（⌘Q 退出、⌘C/⌘V 剪贴板、⌘W 关窗、⌘M 最小化）全部保留。
 */
function installApplicationMenu(language = app.getLocale()) {
  Menu.setApplicationMenu(Menu.buildFromTemplate(applicationMenuTemplate({
    language, isMac: process.platform === 'darwin',
    send: action => { if (!requiredUpdate && win && !win.isDestroyed()) win.webContents.send('app:menu-command', action); },
    checkUpdates: async () => {
      const result = await checkForUpdates();
      if (['available', 'downloading', 'ready'].includes(result.status)) return;
      const zh = language.startsWith('zh');
      await dialog.showMessageBox(win, { type: result.status === 'error' ? 'warning' : 'info', title: 'CoCode',
        message: result.status === 'up-to-date' ? (zh ? '当前已是最新版本' : 'CoCode is up to date')
          : result.status === 'development' ? (zh ? '开发版本不检查更新' : 'Updates are disabled in development')
          : (zh ? '暂时无法检查更新' : 'Unable to check for updates'),
      });
    },
    openWebsite: () => openSafeExternal('https://ohfun.online'),
    openDownloads: () => openSafeExternal(OFFICIAL_DOWNLOAD_URL),
    openLogs: () => shell.openPath(app.getPath('logs')),
    about: () => app.showAboutPanel(),
  })));
}

ipcMain.on('app:language', (_event, language) => {
  if (language === 'zh' || language === 'en') installApplicationMenu(language);
});
app.setAboutPanelOptions({ applicationName: 'CoCode', applicationVersion: app.getVersion() });

async function createWindow() {
  installApplicationMenu();
  scheduleUpdateChecks();
  setDesktopAccessBlocked('account', '正在验证 CoCode 账户');

  // Windows：设置 AppUserModelID，否则任务栏/通知归属到 electron.exe，
  // 图标和「固定到任务栏」都不会按 CoCode 处理。
  if (process.platform === 'win32') {
    app.setAppUserModelId('com.cocode.desktop');
  }

  // macOS Dock 图标：开发模式（electron .）下 Electron 默认图标会被这个覆盖；
  // 打包后由安装器里的 icon.icns 决定，这里再设一次也无妨（所见即所得）。
  if (process.platform === 'darwin' && app.dock) {
    try { app.dock.setIcon(join(__dirname, 'assets', 'icon.png')); } catch { /* 图标缺失不阻塞启动 */ }
  }

  // 在本地端口启动 ASAPI 服务（含静态前端托管）。
  // 端口必须固定（默认 3210）：localStorage 按 origin 隔离，随机端口会让
  // 每次启动的 origin 都不同——RegionGate 的「已同意」记录、主题偏好、
  // 登录态等全部丢失，合规告知就会每次启动都重弹。
  // 3210 被占用（比如浏览器直连着 dev 服务）时退回随机端口，保证能启动。
  let server;
  try {
    server = await startASAPIServer({ port: 3210 });
  } catch (e) {
    if (e?.code !== 'EADDRINUSE') throw e;
    server = await startASAPIServer({ port: 0 });
  }
  const { port } = server.address();
  serverUrl = `http://127.0.0.1:${port}`;

  // 首选上次上报过的主题（用户固定的），没有缓存才跟系统。
  const initialDark = readCachedDark() ?? nativeTheme.shouldUseDarkColors;
  win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 600,
    title: 'CoCode',
    // Windows/Linux 任务栏与窗口图标（macOS 走下面的 app.dock.setIcon）。
    // Windows 正式格式是 .ico（多尺寸内嵌），Linux 用 PNG。
    icon: process.platform === 'win32'
      ? join(__dirname, 'assets', 'icon.ico')
      : join(__dirname, 'assets', 'icon.png'),
    backgroundColor: winBackgroundFor(initialDark),
    // macOS：隐藏标题栏，红绿灯保留并悬浮在应用内部左上角（由前端侧栏头部让位）
    // 非 macOS 平台退回系统标题栏
    ...(process.platform === 'darwin'
      ? { titleBarStyle: 'hidden', trafficLightPosition: { x: 16, y: 16 } }
      : {}),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // 保持 requestAnimationFrame、CSS 动画及计时器在窗口失焦/被遮挡时继续运行。
      // 与上面的 Chromium 帧率开关配合，支持高刷及无上限渲染管线。
      backgroundThrottling: false,
      // 禁用 DevTools：屏蔽 F12 / Cmd+Opt+I / Ctrl+Shift+I 等快捷键，
      // 同时让 webContents.openDevTools() 调用失效（发布形态要求）。
      devTools: false,
      preload: join(__dirname, 'preload.cjs'),
      // 内置浏览器（右侧「浏览器」面板）需要 <webview>。注意这**只**给宿主页面
      // 开了"能创建 webview 元素"的权限；webview 自身的能力在下面的
      // will-attach-webview 里被显式收窄（无 preload、无 Node）。
      webviewTag: true
    }
  });

  // 窗口状态桥：渲染层据此决定 CoCode 标题是否给红绿灯让位
  ipcMain.on('win:is-maximized', (e) => { e.returnValue = win.isMaximized(); });

  // 深浅色桥：渲染层主题就绪/变化时上报实际深浅，同步窗口原生背景（加载页底色）。
  // 同时持久化进 theme-cache.json，下次启动建窗直接用它（用户固定主题零偏差）。
  // 系统主题运行时切换也跟随 —— 但渲染层已上报过（用户固定了主题）则以渲染层为准。
  ipcMain.on('win:set-background', (_e, isDark) => {
    reportedDark = Boolean(isDark);
    win?.setBackgroundColor(winBackgroundFor(reportedDark));
    try { writeFileSync(THEME_CACHE_FILE(), JSON.stringify({ dark: reportedDark })); } catch { /* 只影响下次启动的初值，失败可忽略 */ }
  });
  nativeTheme.on('updated', () => {
    win?.setBackgroundColor(winBackgroundFor(reportedDark ?? nativeTheme.shouldUseDarkColors));
  });


  // 系统文件夹选择器（macOS NSOpenPanel / Windows IFileOpenDialog / Linux zenity）
  // 替代前端自定义目录浏览器：用户在原生对话框里选目录，无需翻页 + 上传 baseURL 后端代理
  ipcMain.handle('dialog:open-folder', async () => {
    const r = await dialog.showOpenDialog(win, {
      properties: ['openDirectory', 'createDirectory'],
      title: '选择文件夹',
      defaultPath: app.getPath('home'),
    });
    if (r.canceled || !r.filePaths[0]) return null;
    return r.filePaths[0];
  });

  // ---------------------------------------------------------------- 语音识别
  // GLM-ASR-2512 云端转写（智谱）：无需本地模型。
  // 双通道：用户自配 Key 时直连；无 Key 时用登录 token 走免费 CoCode ASR。
  // getSecure 在下方凭证存储块定义（函数提升）。
  ipcMain.handle('voice:status', () => voiceStatus({ token: getSecure('token') }));
  ipcMain.handle('voice:transcribe', (_e, samples) => transcribeSamples(samples, { token: getSecure('token') }));

  // ---------------------------------------------------------------- 提示词优化
  // DeepSeek deepseek-flash 改写输入框草稿（Key 从环境变量 DEEPSEEK_API_KEY
  // 或 ~/.cocode/.env 读取，不入库不进包；渲染层直连会被 CORS 拦截，故走主进程代理）。
  ipcMain.handle('prompt-optimizer:run', (_e, text) => optimizePrompt(text));

  // ---------------------------------------------------------------- 凭证安全存储
  // 登录令牌/邮箱/用户名用 safeStorage（macOS Keychain / Windows DPAPI /
  // Linux libsecret）加密后存到 userData 下的 JSON，替代明文 localStorage。
  // XSS 也无法读到密文。safeStorage 不可用时降级明文（dev/无密钥环环境）。
  const AUTH_FILE = join(app.getPath('userData'), 'auth-storage.json');
  const readAuthStore = () => { try { return existsSync(AUTH_FILE) ? JSON.parse(readFileSync(AUTH_FILE, 'utf8')) : {}; } catch { return {}; } };
  const writeAuthStore = (obj) => writeFileSync(AUTH_FILE, JSON.stringify(obj));
  function getSecure(key) {
    const enc = readAuthStore()[key];
    if (!enc) return null;
    if (safeStorage.isEncryptionAvailable()) {
      try { return safeStorage.decryptString(Buffer.from(enc, 'base64')); } catch { return null; }
    }
    return enc; // 降级明文（无密钥环）
  }
  function setSecure(key, val) {
    const obj = readAuthStore();
    if (val == null) delete obj[key];
    else if (safeStorage.isEncryptionAvailable()) obj[key] = safeStorage.encryptString(val).toString('base64');
    else obj[key] = val;
    writeAuthStore(obj);
    if (key === 'token') void refreshAccountAccess();
  }
  async function refreshAccountAccess() {
    const token = getSecure('token');
    if (!token) { setDesktopAccessBlocked('account', '请先登录 CoCode'); return; }
    try {
      const response = await fetch('https://cocode.ohfun.online/auth/me', {
        headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(10000),
      });
      if (token !== getSecure('token')) return;
      if (response.status === 401) { setDesktopAccessBlocked('account', '登录已过期'); return; }
      if (!response.ok) return;
      const account = await response.json();
      if (token === getSecure('token')) setDesktopAccessBlocked('account', account.banned ? account.banReason || '账户已被封禁' : '');
    } catch { /* 断网不覆盖已确认的限制状态。 */ }
  }
  ipcMain.handle('account:refresh', refreshAccountAccess);
  void refreshAccountAccess();
  const KEYS = ['token', 'email', 'username'];
  for (const k of KEYS) {
    // get 同步（sendSync → returnValue）：前端与 localStorage.getItem 同步语义
    ipcMain.on(`auth:get-${k}`, (e) => { e.returnValue = getSecure(k); });
    // set/del 异步（invoke）：写文件不阻塞渲染层
    ipcMain.handle(`auth:set-${k}`, (_e, v) => setSecure(k, v));
    ipcMain.handle(`auth:del-${k}`, () => setSecure(k, null));
  }

  // 权限白名单：只放行麦克风/通知/全屏/指针锁/剪贴板写；其余（剪贴板读、
  // HID、USB、openExternal、摄像头等）一律拒绝，防止嵌入网页借宿主权限越权。
  // clipboard-sanitized-write 必须放行：设置了 PermissionCheckHandler 后，
  // navigator.clipboard.writeText 会走该权限检查（见 electron#31319），
  // 拒绝它会让消息气泡的「复制」按钮无声失败。只放「写」，读剪贴板
  // （clipboard-read）仍被拒，不破坏防越权初衷。
  // 旧版对非 macOS 的任意 permission 直接 callback(true)，等于裸奔。
  const ALLOWED_PERMISSIONS = new Set([
    'media',
    'notifications',
    'pointerLock',
    'fullscreen',
    'clipboard-sanitized-write',
  ]);
  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => {
    if (permission === 'media' && process.platform === 'darwin') {
      systemPreferences.askForMediaAccess('microphone').then(callback);
      return;
    }
    callback(ALLOWED_PERMISSIONS.has(permission));
  });
  // 同步校验：已授权权限的运行时查询也走白名单
  session.defaultSession.setPermissionCheckHandler((_wc, permission) =>
    ALLOWED_PERMISSIONS.has(permission)
  );

  // CSP 纵深防御：connect-src 只允许同源 + auth worker 域名；object-src 禁用。
  // 即使渲染层发生 XSS，token 与数据也 fetch 不出到任意第三方域名。
  // challenges.cloudflare.com 是 Cloudflare Turnstile 人机验证的固定域：
  // script-src 加载 api.js、frame-src 渲染其 sandbox iframe、connect-src 供
  // iframe 内部换 token。白名单只到该域，不放通配。
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    // 只给自家 origin 注入 CSP。onHeadersReceived 覆盖所有响应——若不加判断，
    // Turnstile iframe（challenges.cloudflare.com）自己的文档也会被强加
    // default-src 'self'，其内部 blob worker/eval 全被拦 → widget 渲染为空白。
    if (!serverUrl || !details.url.startsWith(serverUrl)) {
      callback({ responseHeaders: details.responseHeaders });
      return;
    }
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [
          "default-src 'self'; " +
          "script-src 'self' https://challenges.cloudflare.com; " +
          "style-src 'self' 'unsafe-inline'; " +
          "img-src 'self' data: blob: https:; " +
          "connect-src 'self' https://cocode.ohfun.online wss://cocode.ohfun.online https://challenges.cloudflare.com; " +
          "media-src 'self' blob:; " +
          "font-src 'self' data:; " +
          "object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'; " +
          "frame-src https://challenges.cloudflare.com;",
        ],
      },
    });
  });

  // 内置浏览器的安全收窄：<webview> 只用来显示网页，不需要任何 Node 能力。
  // 不写这一条的话，webview 会继承宿主的一些默认值，等于凭空多一个攻击面。
  win.webContents.on('will-attach-webview', (event, webPreferences, params) => {
    delete webPreferences.preload;
    webPreferences.nodeIntegration = false;
    webPreferences.contextIsolation = true;
    // 内置浏览器的 <webview> 同样禁 DevTools（右键「检查」/ inspect 属性入口）
    webPreferences.devTools = false;
    const src = params.src || '';
    if (src && src !== 'about:blank' && !/^https?:/i.test(src)) event.preventDefault();
  });

  // 不让主窗口被页面或 XSS 导航到外站；外链交给系统浏览器，内部弹窗也不新开
  // 带 Electron 能力的窗口。字符串 startsWith 会误把 127.0.0.1:3210.evil 当站内，
  // 因而必须按 URL origin 比较。
  win.webContents.on('will-navigate', (event, url) => {
    if (isAppUrl(url, serverUrl)) return;
    event.preventDefault();
    void openSafeExternal(url);
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (!isAppUrl(url, serverUrl)) void openSafeExternal(url);
    return { action: 'deny' };
  });

  // preload 在 React 执行前写入当前 origin，无需整页刷新和重复初始化。
  await win.loadURL(serverUrl + '/');

  attachBrowserDriver(win);
  scheduleUpdateChecks();
  win.on('closed', () => {
    win = null;
    // 驱动持有 win 引用；窗口没了必须摘掉，否则工具会对着一个销毁的
    // webContents 调 executeJavaScript（报错信息还很难懂）。
    clearBrowserDriver();
    // 语音识别已改为云端 GLM-ASR（voice.js 无本地识别器），原
    // disposeVoiceRecognizer() 随 sherpa-onnx 一起移除，此处无需释放。
  });
}

/**
 * 把 Browser 工具接到渲染层的内置浏览器上。
 *
 * 链路是两跳：主进程 → `executeJavaScript` 调渲染层的 `window.__cocodeBrowser` →
 * 面板里的 `<webview>`。之所以不把浏览器做成主进程的 WebContentsView：面板是
 * HTML 布局的一部分（可拖拽、可上下堆叠），让浏览器跟着 React 树走最省事，代价
 * 是中间多一跳转发。
 *
 * 面板没打开时渲染层里没有这个桥，所以先派发事件请前端把面板打开，再轮询等它注册。
 * 这段等待必须有超时 —— 否则工具会永久挂住，而模型只会看到"卡住了"。
 */
function attachBrowserDriver(win) {
  const call = (action, params) =>
    win.webContents.executeJavaScript(
      `(window.__cocodeBrowser
         ? window.__cocodeBrowser.call(${JSON.stringify(action)}, ${JSON.stringify(params || {})})
         : Promise.reject(new Error('__NO_BRIDGE__')))`,
      true
    );

  setBrowserDriver(async (action, params) => {
    try {
      return await call(action, params);
    } catch (e) {
      if (!String(e?.message || e).includes('__NO_BRIDGE__')) throw e;
    }

    // 面板还没开：请前端把它打开
    await win.webContents.executeJavaScript(
      `window.dispatchEvent(new CustomEvent('cocode:open-panel', { detail: 'browser' }));true`,
      true
    );

    const deadline = Date.now() + 8000;
    let lastErr = null;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 250));
      if (win.isDestroyed()) throw new Error('窗口已关闭');
      try {
        return await call(action, params);
      } catch (e) {
        lastErr = e;
      }
    }
    throw new Error(`内置浏览器面板没能就绪${lastErr ? '：' + lastErr.message : ''}`);
  });
}

// 单实例
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) { win.isMinimized() ? win.restore() : win.focus(); }
  });

  // webview 里的页面尝试弹新窗口（target="_blank"、window.open()）。
  // 前提：前端给 <webview> 开了 allowpopups，否则请求在 guest 渲染层就被
  // Chromium 拦掉，根本到不了这里。到达后一律 deny（不真的开系统窗口），
  // 把 url 转给渲染层，由内置浏览器开成一个新的标签页。
  app.on('web-contents-created', (_event, contents) => {
    if (contents.getType() !== 'webview') return;
    contents.setWindowOpenHandler(({ url }) => {
      if (/^https?:/i.test(url) && win && !win.isDestroyed()) {
        win.webContents.send('browser:popup', url);
      }
      return { action: 'deny' };
    });
  });

  app.whenReady().then(() => {
    // WebFetch/WebSearch 使用 Chromium 网络栈以继承系统代理；Node fetch 不会。
    // URL 与逐跳 DNS 安全校验仍由 core/src/tools/web.js 在请求前执行。
    // 不带内置浏览器的登录 Cookie，避免模型的网页读取继承用户会话。
    setWebFetcher((url, init) => net.fetch(url, {
      ...init, credentials: 'omit', bypassCustomProtocolHandlers: true,
    }));
    return createWindow();
  });
  app.on('window-all-closed', () => process.platform !== 'darwin' && app.quit());
  app.on('activate', () => { if (!win) createWindow(); });
}
