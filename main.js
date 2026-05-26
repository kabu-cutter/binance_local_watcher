const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const localEngine = require('./local_engine');

let mainWindow = null;

function registerLocalEngineIpc() {
  ipcMain.handle('blw:engine', async (_event, route, payload) => {
    try {
      return { ok: true, data: await localEngine.invoke(route, payload) };
    } catch (error) {
      return { ok: false, error: error.message || String(error) };
    }
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    // HD横画面(1366x768など)でも下が切れにくい初期サイズ。
    // 画面内に収まらない場合も、main/sidebarがそれぞれスクロールする。
    width: 1240,
    height: 700,
    minWidth: 980,
    minHeight: 560,
    backgroundColor: '#fff5fb',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
    },
  });

  mainWindow.loadFile('index.html');
  mainWindow.once('ready-to-show', () => {
    console.log('[electron] engine boundary: renderer -> preload -> ipcMain -> local_engine');
  });
}

app.whenReady().then(() => {
  registerLocalEngineIpc();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
