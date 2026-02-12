const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');

const defaultConfig = { window: { width: 720, height: 720, alwaysOnTop: true } };

function loadConfig() {
  const configPath = path.join(__dirname, 'config.json');
  try {
    const raw = fs.readFileSync(configPath, 'utf8');
    const cleaned = raw.replace(/^\uFEFF/, '');
    const parsed = JSON.parse(cleaned);
    console.log('config loaded', configPath);
    return parsed;
  } catch (err) {
    console.warn('config load failed', configPath, err.message);
    return defaultConfig;
  }
}

app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
app.disableHardwareAcceleration();
// Keep a stable scale factor to avoid size changes when moving between monitors.
app.commandLine.appendSwitch('force-device-scale-factor', '1');

let win;

app.whenReady().then(() => {
  const config = loadConfig();
  const w = Number((config.window && config.window.width) || defaultConfig.window.width);
  const h = Number((config.window && config.window.height) || defaultConfig.window.height);
  const alwaysOnTop =
    config.window && typeof config.window.alwaysOnTop === 'boolean'
      ? config.window.alwaysOnTop
      : defaultConfig.window.alwaysOnTop;

  const winSize = { w, h };

  win = new BrowserWindow({
    width: w,
    height: h,
    useContentSize: true,
    transparent: true,
    frame: false,
    resizable: false,
    alwaysOnTop,
    skipTaskbar: true,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: false,
      nodeIntegration: true,
      sandbox: false
    }
  });

  // Force size in case any DPI/restore state overrides the initial bounds.
  win.setSize(w, h);
  win.setContentSize(w, h);
  console.log('window size set to', w, h);

  win.loadFile(path.join(__dirname, 'index.html'));

  ipcMain.on('move-window', (_evt, pos) => {
    if (!win || !pos) return;
    win.setBounds({
      x: Math.round(pos.x),
      y: Math.round(pos.y),
      width: winSize.w,
      height: winSize.h
    });
  });

  ipcMain.on('app-quit', () => {
    app.quit();
  });

  ipcMain.handle('get-window-pos', () => {
    if (!win) return { x: 0, y: 0 };
    const [x, y] = win.getPosition();
    return { x, y };
  });
});

app.on('window-all-closed', () => {
  app.quit();
});
