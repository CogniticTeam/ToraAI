// 仅供 test-browser-electron.mjs 使用的隔离 Electron 壳，不启动真实用户实例。
const { app, BrowserWindow } = require('electron');

app.setPath('userData', process.env.COCODE_BROWSER_TEST_USER_DATA);
app.whenReady().then(() => {
	const win = new BrowserWindow({
		width: 1360, height: 850, show: false,
		webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, webviewTag: true },
	});
	win.webContents.on('will-attach-webview', (_event, preferences) => {
		delete preferences.preload;
		preferences.nodeIntegration = false;
		preferences.contextIsolation = true;
	});
	void win.loadURL('about:blank');
});
app.on('window-all-closed', () => app.quit());
