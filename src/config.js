'use strict';

/**
 * 配置读写：%APPDATA%\<productName>\config.json（由 app.getPath('userData') 决定）
 */

const fs = require('fs');
const path = require('path');

const MIN_INTERVAL = 250;
const MAX_INTERVAL = 10000;

const DEFAULTS = {
  intervalMs: 1000,
  alwaysOnTop: true,
  clickThrough: false,
  launchAtLogin: false,
  smoothing: 0.5,
  window: { x: null, y: null }
};

function clampInterval(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return DEFAULTS.intervalMs;
  return Math.min(MAX_INTERVAL, Math.max(MIN_INTERVAL, Math.round(number)));
}

function clampSmoothing(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return DEFAULTS.smoothing;
  return Math.min(1, Math.max(0, number));
}

function createConfigStore(userDataDir) {
  const file = path.join(userDataDir, 'config.json');
  let data = {
    ...DEFAULTS,
    window: { ...DEFAULTS.window }
  };

  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (raw && typeof raw === 'object') {
      data = {
        ...data,
        ...raw,
        window: { ...data.window, ...(raw.window || {}) }
      };
    }
  } catch (err) {
    /* 首次运行或文件损坏，直接用默认值 */
  }

  data.intervalMs = clampInterval(data.intervalMs);
  data.smoothing = clampSmoothing(data.smoothing);

  let pending = null;

  const write = () => {
    pending = null;
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
    } catch (err) {
      // 配置写不进去不应该影响测速
      console.error('[net-speed-widget] 写入配置失败:', err.message);
    }
  };

  const schedule = () => {
    if (pending) return;
    pending = setTimeout(write, 400);
    if (pending.unref) pending.unref();
  };

  return {
    file,
    get(key) {
      if (key === undefined) {
        return { ...data, window: { ...data.window } };
      }
      return data[key];
    },
    set(key, value) {
      data[key] = value;
      schedule();
    },
    getWindowPosition() {
      const { x, y } = data.window;
      return Number.isInteger(x) && Number.isInteger(y) ? { x, y } : null;
    },
    setWindowPosition(x, y) {
      if (data.window.x === x && data.window.y === y) return;
      data.window = { x: Math.round(x), y: Math.round(y) };
      schedule();
    },
    resetWindowPosition() {
      data.window = { ...DEFAULTS.window };
      schedule();
    },
    flush: write
  };
}

module.exports = {
  createConfigStore,
  clampInterval,
  clampSmoothing,
  DEFAULTS,
  MIN_INTERVAL,
  MAX_INTERVAL
};
