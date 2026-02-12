const { contextBridge, ipcRenderer } = require('electron');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

function toFileUrl(relPath) {
  const abs = path.resolve(__dirname, relPath);
  return pathToFileURL(abs).href;
}

function listPngFrames(relDir) {
  const absDir = path.resolve(__dirname, relDir);
  if (!fs.existsSync(absDir)) return [];
  const files = fs
    .readdirSync(absDir)
    .filter((f) => f.toLowerCase().endsWith('.png'))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }));
  return files.map((f) => pathToFileURL(path.join(absDir, f)).href);
}

function buildSequence(seq) {
  if (!seq || !seq.dir) return [];
  const start = Number.isFinite(seq.start) ? seq.start : 0;
  const end = Number.isFinite(seq.end) ? seq.end : -1;
  const digits = Number.isFinite(seq.digits) ? seq.digits : 4;
  const prefix = seq.prefix || '';
  const ext = seq.ext || '.png';
  const absDir = path.resolve(__dirname, seq.dir);

  if (end < start) {
    if (!fs.existsSync(absDir)) return [];
    const files = fs
      .readdirSync(absDir)
      .filter((f) => f.toLowerCase().endsWith('.png'))
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }));
    return files.map((f) => pathToFileURL(path.join(absDir, f)).href);
  }

  const frames = [];
  for (let i = start; i <= end; i += 1) {
    const name = `${prefix}${String(i).padStart(digits, '0')}${ext}`;
    const abs = path.join(absDir, name);
    frames.push(pathToFileURL(abs).href);
  }
  return frames;
}

contextBridge.exposeInMainWorld('petApi', {
  readConfig: () => {
    const configPath = path.join(__dirname, 'config.json');
    const raw = fs.readFileSync(configPath, 'utf8');
    return JSON.parse(raw.replace(/^\uFEFF/, ''));
  },
  moveWindow: (x, y) => ipcRenderer.send('move-window', { x, y }),
  getWindowPos: () => ipcRenderer.invoke('get-window-pos'),
  quitApp: () => ipcRenderer.send('app-quit'),
  exists: (relPath) => fs.existsSync(path.resolve(__dirname, relPath)),
  toFileUrl,
  listPngFrames,
  buildSequence
});
