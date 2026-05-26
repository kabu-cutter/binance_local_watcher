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
    width: 1280,
    height: 820,
    minWidth: 1080,
    minHeight: 720,
    backgroundColor: '#f4f6f8',
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
