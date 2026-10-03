// Read-only window-position diagnostics. Native UI actions are performed separately.
const { app } = require('electron');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
app.on('browser-window-created', (_event, win) => {
	const report = (event) => console.log('TORA_DRAG_BOUNDS', JSON.stringify({ event, ...win.getBounds() }));
	win.once('ready-to-show', () => report('ready'));
	win.webContents.once('did-finish-load', () => report('loaded'));
	win.on('move', () => report('move'));
});
import(pathToFileURL(path.resolve(__dirname, '../packages/desktop/main.js')).href);
