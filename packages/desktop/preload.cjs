// 预加载桥：向渲染层暴露窗口状态（是否最大化），用于 CoCode 标题动态让位红绿灯。
// sandbox 模式下 preload 仅可使用 electron 白名单模块（contextBridge/ipcRenderer）。
const { contextBridge, ipcRenderer } = require('electron');

// 隔离世界和页面共享同一 origin 的 localStorage。先完成连接初始化，
// 再运行页面模块，避免第一次挂载请求错误端口以及启动后整页 reload。
if (process.isMainFrame && window.location.protocol === 'http:' && window.location.hostname === '127.0.0.1') {
	localStorage.setItem('server_url', window.location.origin);
	localStorage.setItem('username', 'cocode');
}

contextBridge.exposeInMainWorld('cocodeWindow', {
	// Electron 根据操作系统与应用语言设置解析的区域（如 zh-CN / en-US）。
	getSystemLocale: () => ipcRenderer.sendSync('app:get-system-locale'),
	// 同步查询当前是否最大化
	isMaximized: () => ipcRenderer.sendSync('win:is-maximized'),
	// 订阅最大化状态变化（含全屏进入/退出）
	onMaximizeChange: (cb) => {
		ipcRenderer.on('win:maximized-changed', (_event, value) => cb(value));
	},
	// 弹出系统文件夹选择对话框（macOS NSOpenPanel / Windows IFileOpenDialog）。
	// 返回用户选中的绝对路径；用户取消返回 null。浏览器环境无此 API，需调用方判空。
	openFolderDialog: () => ipcRenderer.invoke('dialog:open-folder'),
	// 上报当前实际深浅，同步窗口原生背景（加载页/首帧前那块底色）。
	reportTheme: (isDark) => ipcRenderer.send('win:set-background', Boolean(isDark)),
	// 更新检查由主进程完成：macOS / Windows 均使用 electron-updater 后台下载。
	// 渲染层无权访问更新源或直接执行安装。
	checkForUpdates: () => ipcRenderer.invoke('updates:check'),
	getAppVersion: () => ipcRenderer.sendSync('app:get-version'),
	getRequiredUpdate: () => ipcRenderer.sendSync('updates:state'),
	onRequiredUpdate: (cb) => {
		const handler = (_event, state) => cb(state);
		ipcRenderer.on('updates:required', handler);
		return () => ipcRenderer.removeListener('updates:required', handler);
	},
	updateAction: (action) => ipcRenderer.invoke('updates:action', action),
	refreshAccount: () => ipcRenderer.invoke('account:refresh'),
	reportLanguage: (language) => ipcRenderer.send('app:language', language),
	onMenuCommand: (cb) => {
		const handler = (_event, action) => cb(action);
		ipcRenderer.on('app:menu-command', handler);
		return () => ipcRenderer.removeListener('app:menu-command', handler);
	},
});

// 凭证安全存储桥：token/email/username 用 safeStorage 加密存主进程，
// 替代明文 localStorage。get 同步（与 localStorage.getItem 同步语义，减少前端改动），
// set/del 异步。浏览器环境（无 cocodeAuth）时前端 fallback 到 localStorage。
contextBridge.exposeInMainWorld('cocodeAuth', {
	getToken: () => ipcRenderer.sendSync('auth:get-token'),
	getEmail: () => ipcRenderer.sendSync('auth:get-email'),
	getUsername: () => ipcRenderer.sendSync('auth:get-username'),
	setToken: (v) => ipcRenderer.invoke('auth:set-token', v),
	setEmail: (v) => ipcRenderer.invoke('auth:set-email', v),
	setUsername: (v) => ipcRenderer.invoke('auth:set-username', v),
	delToken: () => ipcRenderer.invoke('auth:del-token'),
	delEmail: () => ipcRenderer.invoke('auth:del-email'),
	delUsername: () => ipcRenderer.invoke('auth:del-username'),
});

// 内置浏览器桥：内置浏览器的 <webview> 里页面尝试弹新窗口（target="_blank"、
// window.open()）时，主进程统一拦截并把这个跳转请求转给渲染层，由前端开成新的
// 标签页。浏览器环境（非 Electron）无此桥，前端不订阅即可。
contextBridge.exposeInMainWorld('cocodeBrowserHost', {
	onPopup: (cb) => {
		ipcRenderer.on('browser:popup', (_event, url) => cb(url));
	},
});

// 语音识别桥（GLM-ASR-2512 云端转写）。
// 浏览器环境无此桥，前端需判 window.cocodeVoice 是否存在来决定语音入口是否可用。
contextBridge.exposeInMainWorld('cocodeVoice', {
	// 资源状态 { dir, installed, cloud } —— 云端方案 = 配好 Key 即 installed
	status: () => ipcRenderer.invoke('voice:status'),
// 转写 16kHz 单声道 Float32Array PCM → 文本
	transcribe: (samples) => ipcRenderer.invoke('voice:transcribe', samples),
});

// 提示词优化桥：主进程代理调用 DeepSeek（渲染层直连会被 CORS 拦截）。
// 浏览器环境（非 Electron）无此桥，前端据此隐藏优化按钮。
contextBridge.exposeInMainWorld('cocodePromptOptimizer', {
	optimize: (text) => ipcRenderer.invoke('prompt-optimizer:run', text),
});
