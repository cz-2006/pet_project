const spriteEl = document.getElementById('sprite');
const closeBtn = document.getElementById('close-btn');
const debugEl = document.getElementById('debug');

function showDebug(msg) {
  if (!debugEl) return;
  debugEl.textContent = msg;
  debugEl.style.display = 'block';
}

window.addEventListener('error', (e) => {
  showDebug(`Runtime error: ${e.message}`);
});

let petApi = window.petApi || null;

if (!petApi && window.require) {
  try {
    const fs = window.require('fs');
    const path = window.require('path');
    const { pathToFileURL, fileURLToPath } = window.require('url');

    const baseDir = path.dirname(fileURLToPath(window.location.href));

    petApi = {
      readConfig: () => {
        const configPath = path.join(baseDir, 'config.json');
        const raw = fs.readFileSync(configPath, 'utf8');
        return JSON.parse(raw.replace(/^\uFEFF/, ''));
      },
      moveWindow: (x, y) => {
        window.require('electron').ipcRenderer.send('move-window', { x, y });
      },
      getWindowPos: () => window.require('electron').ipcRenderer.invoke('get-window-pos'),
      quitApp: () => window.require('electron').ipcRenderer.send('app-quit'),
      exists: (relPath) => fs.existsSync(path.resolve(baseDir, relPath)),
      toFileUrl: (relPath) => pathToFileURL(path.resolve(baseDir, relPath)).href,
      listPngFrames: (relDir) => {
        const absDir = path.resolve(baseDir, relDir);
        if (!fs.existsSync(absDir)) return [];
        const files = fs
          .readdirSync(absDir)
          .filter((f) => f.toLowerCase().endsWith('.png'))
          .sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }));
        return files.map((f) => pathToFileURL(path.join(absDir, f)).href);
      },
      buildSequence: (seq) => {
        if (!seq || !seq.dir) return [];
        const start = Number.isFinite(seq.start) ? seq.start : 0;
        const end = Number.isFinite(seq.end) ? seq.end : -1;
        const digits = Number.isFinite(seq.digits) ? seq.digits : 4;
        const prefix = seq.prefix || '';
        const ext = seq.ext || '.png';
        const absDir = path.resolve(baseDir, seq.dir);

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
    };
    window.petApi = petApi;
  } catch (err) {
    showDebug(`Fallback petApi failed: ${err.message}`);
  }
}

if (!petApi) {
  showDebug('petApi missing: preload not loaded.');
  throw new Error('petApi missing');
}

if (closeBtn) {
  closeBtn.addEventListener('pointerdown', (e) => {
    e.stopPropagation();
  });
  closeBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (petApi && petApi.quitApp) {
      petApi.quitApp();
      return;
    }
    if (window.require) {
      window.require('electron').ipcRenderer.send('app-quit');
    }
  });
}

let cfg = { idle: { src: '' }, actions: {}, triggers: {} };
try {
  cfg = petApi.readConfig();
} catch (err) {
  showDebug(`Config error: ${err.message}`);
}

let idleRel = cfg.idle && cfg.idle.src ? cfg.idle.src : '';
if (!idleRel) {
  const fallback = '../assets/ori.png';
  if (petApi.exists(fallback)) {
    idleRel = fallback;
    showDebug('Idle path missing in config. Using fallback ../assets/ori.png');
  } else {
    showDebug(
      `Idle image path missing in config. keys=${Object.keys(cfg).join(',') || 'none'}`
    );
  }
}
const idleSrc = idleRel ? petApi.toFileUrl(idleRel) : '';
const idleCandidates = [idleSrc, idleRel].filter(Boolean);
let idleIndex = 0;

if (!idleCandidates.length) {
  showDebug('Idle image path missing in config.');
}
if (idleRel && !petApi.exists(idleRel)) {
  showDebug(`Idle file not found: ${idleRel}`);
}

function setIdleImage() {
  if (!idleCandidates.length) return;
  spriteEl.src = idleCandidates[idleIndex];
}

spriteEl.addEventListener('error', () => {
  if (idleIndex + 1 < idleCandidates.length) {
    idleIndex += 1;
    spriteEl.src = idleCandidates[idleIndex];
    return;
  }
  showDebug(`Image load error: ${spriteEl.src || '(empty)'}`);
});

spriteEl.addEventListener('load', () => {
  if (debugEl) debugEl.style.display = 'none';
});

setIdleImage();

let state = 'idle';
const cooldowns = new Map();
let playTimer = null;
let autoTimer = null;
let lastAutoAction = null;

const actionCache = new Map();

function nowMs() {
  return Date.now();
}

function isCooling(name) {
  const until = cooldowns.get(name) || 0;
  return nowMs() < until;
}

function setCooldown(name, sec) {
  if (!sec) return;
  cooldowns.set(name, nowMs() + sec * 1000);
}

function clearAutoTimer() {
  if (autoTimer) {
    clearTimeout(autoTimer);
    autoTimer = null;
  }
}

function getAutoConfig() {
  const interval = Number(
    (cfg.triggers && cfg.triggers.autoIntervalSec) ||
      (cfg.triggers && cfg.triggers.idleTimeoutSec) ||
      15
  );
  const pool =
    (cfg.triggers && cfg.triggers.autoPool) ||
    (cfg.triggers && cfg.triggers.random && cfg.triggers.random.pool) ||
    ['dull', 'cry', 'yawn'];
  return { intervalSec: interval, pool };
}

function pickAutoAction() {
  const { pool } = getAutoConfig();
  const candidates = pool.filter((name) => {
    const data = getActionData(name);
    return data && data.frames && data.frames.length;
  });
  if (!candidates.length) return null;
  let pickPool = candidates;
  if (pickPool.length > 1 && lastAutoAction) {
    const filtered = pickPool.filter((name) => name !== lastAutoAction);
    if (filtered.length) pickPool = filtered;
  }
  const idx = Math.floor(Math.random() * pickPool.length);
  const chosen = pickPool[idx];
  lastAutoAction = chosen;
  return chosen;
}

function scheduleAutoTimer() {
  clearAutoTimer();
  const { intervalSec } = getAutoConfig();
  if (!intervalSec || intervalSec <= 0) return;
  autoTimer = setTimeout(() => {
    if (state !== 'idle') return;
    const chosen = pickAutoAction();
    if (!chosen) return;
    playAction(chosen, { force: true, ignoreCooldown: true });
  }, intervalSec * 1000);
}

function stopPlayback() {
  if (playTimer) {
    clearInterval(playTimer);
    playTimer = null;
  }
  state = 'idle';
  setIdleImage();
  scheduleAutoTimer();
}

function getActionData(name) {
  if (actionCache.has(name)) return actionCache.get(name);
  const action = cfg.actions && cfg.actions[name];
  if (!action) return null;

  if (action.dir && !petApi.exists(action.dir)) {
    showDebug(`Action dir not found: ${action.dir}`);
  }

  let frames = [];
  if (Array.isArray(action.frames) && action.frames.length) {
    frames = action.frames.map((p) => petApi.toFileUrl(p));
  } else if (action.seq) {
    frames = petApi.buildSequence(action.seq);
  } else if (action.dir) {
    frames = petApi.listPngFrames(action.dir);
  }

  const fps = action.fps || 24;
  const preloadCount = Number.isFinite(action.preloadCount) ? action.preloadCount : 5;
  for (let i = 0; i < Math.min(preloadCount, frames.length); i += 1) {
    const img = new Image();
    img.src = frames[i];
  }

  const data = { frames, fps };
  actionCache.set(name, data);
  return data;
}

function playAction(name, opts = {}) {
  const action = cfg.actions && cfg.actions[name];
  if (!action) return;
  if (!opts.ignoreCooldown && !opts.force && isCooling(name)) return;
  if (state === 'playing' && !opts.force) return;

  const data = getActionData(name);
  if (!data || !data.frames.length) {
    showDebug(`No frames for action: ${name}`);
    return;
  }

  if (playTimer) clearInterval(playTimer);
  clearAutoTimer();
  state = 'playing';
  setCooldown(name, action.cooldown || 0);

  let idx = 0;
  spriteEl.src = data.frames[0];

  const interval = Math.max(16, Math.round(1000 / data.fps));
  playTimer = setInterval(() => {
    idx += 1;
    if (idx >= data.frames.length) {
      if (action.loop) {
        idx = 0;
        spriteEl.src = data.frames[0];
        return;
      }
      stopPlayback();
      return;
    }
    spriteEl.src = data.frames[idx];
  }, interval);
}

function bindTriggers() {
  document.addEventListener('click', () => {
    if (cfg.triggers && cfg.triggers.click) {
      playAction(cfg.triggers.click, { force: true, ignoreCooldown: true });
    }
  });

  document.addEventListener('dblclick', () => {
    if (cfg.triggers && cfg.triggers.dblclick) {
      playAction(cfg.triggers.dblclick, { force: true, ignoreCooldown: true });
    }
  });
}

let dragging = false;
let dragStart = { x: 0, y: 0 };
let winStart = { x: 0, y: 0 };

function bindDrag() {
  document.addEventListener('pointerdown', async (e) => {
    if (e.button !== 0) return;
    dragging = true;
    dragStart = { x: e.screenX, y: e.screenY };
    winStart = await petApi.getWindowPos();
    try {
      document.body.setPointerCapture(e.pointerId);
    } catch (_) {}
    // Dragging should not reset the auto timer; clicks handle immediate actions.
  });

  document.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    const dx = e.screenX - dragStart.x;
    const dy = e.screenY - dragStart.y;
    petApi.moveWindow(winStart.x + dx, winStart.y + dy);
  });

  document.addEventListener('pointerup', (e) => {
    if (!dragging) return;
    dragging = false;
    try {
      document.body.releasePointerCapture(e.pointerId);
    } catch (_) {}
  });
}

stopPlayback();
scheduleAutoTimer();
bindTriggers();
bindDrag();
