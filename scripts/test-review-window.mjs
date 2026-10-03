import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';
import { createWindowIpc } from '../packages/desktop/window-ipc.js';

test('macOS 关闭并重开窗口不重复 IPC，不改变服务端口，不泄漏监听', async () => {
  const source = readFileSync(new URL('../packages/desktop/main.js', import.meta.url), 'utf8');
  const windowCode = source.slice(source.indexOf('async function createWindow()'), source.indexOf('\n/**\n * 把 Browser 工具'));
  const handlers = new Map(), ipcMain = new EventEmitter(), pages = [];
  let closeDuringLoad = false;
  ipcMain.handle = (name, handler) => {
    if (handlers.has(name)) throw Error(`Duplicate IPC: ${name}`);
    handlers.set(name, handler);
  };
  ipcMain.removeHandler = name => handlers.delete(name);
  class Window extends EventEmitter {
    constructor() { super(); this.webContents = new EventEmitter(); Object.assign(this.webContents, { mainFrame: {}, send() {}, setWindowOpenHandler() {} }); }
    loadURL(url) { pages.push(url); if (closeDuringLoad) { this.emit('closed'); return Promise.reject(Error('Closed while loading')); } return Promise.resolve(); }
  }
  let servers = 0;
  const nativeTheme = new EventEmitter();
  const context = vm.createContext({
    app: { getLocale: () => 'zh-CN', getPath: () => '/fixture-only', isPackaged: false },
    process: { platform: 'darwin', argv: [] }, console,
    normalizeNativeLanguage: value => value, installApplicationMenu() {}, scheduleUpdateChecks() {}, setDesktopAccessBlocked() {},
    startASAPIServer: async () => { servers++; return { address: () => ({ port: 3210 }) }; },
    localServer: null, windowCreation: null, readCachedDark: () => false, nativeTheme, BrowserWindow: Window,
    winBackgroundFor: () => '', __dirname: '/fixture', join, ipcMain, createWindowIpc,
    dialog: {}, voiceStatus() {}, transcribeSamples() {}, optimizePrompt() {}, existsSync: () => false,
    readFileSync: () => '', writeFileSync() {}, safeStorage: {},
    session: { defaultSession: { setPermissionRequestHandler() {}, setPermissionCheckHandler() {}, webRequest: { onHeadersReceived() {} } } },
    clearBrowserDriver() {}, attachBrowserDriver() {}, win: null, serverUrl: '', notificationLanguage: '', reportedDark: false,
  });
  vm.runInContext(windowCode, context);
  for (let i = 0; i < 3; i++) {
    await Promise.all([context.ensureWindow(), context.ensureWindow()]);
    assert.equal(ipcMain.listenerCount('auth:get-token'), 1);
    assert.equal(nativeTheme.listenerCount('updated'), 1);
    assert.ok(handlers.has('dialog:open-folder'));
    context.win.emit('closed');
    assert.equal(handlers.size, 0);
    assert.equal(ipcMain.listenerCount('auth:get-token'), 0);
    assert.equal(nativeTheme.listenerCount('updated'), 0);
  }
  assert.equal(servers, 1);
  assert.deepEqual(pages, Array(3).fill('http://127.0.0.1:3210/'));
  closeDuringLoad = true; await context.ensureWindow();
  assert.equal(handlers.size, 0);
  closeDuringLoad = false; await context.ensureWindow();
  assert.ok(handlers.has('dialog:open-folder'));
  context.win.emit('closed');
  assert.equal(servers, 1);
});
