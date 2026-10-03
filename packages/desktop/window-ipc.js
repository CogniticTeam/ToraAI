// IPC bindings belong to a window's lifetime, not every future recreation.
export function createWindowIpc(ipcMain) {
  const disposers = [];
  return {
    on(channel, listener) {
      ipcMain.on(channel, listener);
      disposers.push(() => ipcMain.removeListener(channel, listener));
    },
    handle(channel, listener) {
      ipcMain.handle(channel, listener);
      disposers.push(() => ipcMain.removeHandler(channel));
    },
    dispose() { for (const dispose of disposers.splice(0).reverse()) dispose(); },
  };
}
