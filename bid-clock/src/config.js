'use strict';

/**
 * 配置读写：%APPDATA%\BidClock\config.json（路径由 app.getPath('userData') 决定）
 *
 * 存两类东西：
 *   1. 开标时间 + 界面状态（置顶、字号高度、宽高比）
 *   2. 悬浮钟的位置（下次启动原地出现）
 */

const fs = require('fs');
const path = require('path');

const { isBidTime, normalizeBidTime } = require('./schedule');
const {
  DEFAULT_HEIGHT,
  DEFAULT_ASPECT,
  clampHeight,
  clampAspect
} = require('./geometry');

const DEFAULTS = {
  /** 'HH:MM'；null 表示还没选过（启动时先弹设置界面） */
  bidTime: null,
  alwaysOnTop: true,
  /** 悬浮钟高度，宽度由它 × 宽高比得到 */
  height: DEFAULT_HEIGHT,
  /** 宽高比由渲染进程按实际字宽量出来后写回，保证任何尺寸下字都撑满窗口 */
  aspect: DEFAULT_ASPECT,
  window: { x: null, y: null }
};

function sanitize(raw) {
  const data = {
    ...DEFAULTS,
    window: { ...DEFAULTS.window }
  };

  if (!raw || typeof raw !== 'object') return data;

  data.bidTime = isBidTime(raw.bidTime) ? normalizeBidTime(raw.bidTime) : null;
  data.alwaysOnTop = raw.alwaysOnTop === undefined ? DEFAULTS.alwaysOnTop : Boolean(raw.alwaysOnTop);
  data.height = clampHeight(raw.height);
  data.aspect = clampAspect(raw.aspect);
  data.window = { ...data.window, ...(raw.window || {}) };

  return data;
}

function createConfigStore(userDataDir) {
  const file = path.join(userDataDir, 'config.json');
  let data = { ...DEFAULTS, window: { ...DEFAULTS.window } };

  try {
    data = sanitize(JSON.parse(fs.readFileSync(file, 'utf8')));
  } catch (err) {
    /* 首次运行或文件损坏，直接用默认值 */
  }

  let pending = null;

  const write = () => {
    pending = null;
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
    } catch (err) {
      // 配置写不进去不应该影响显示时间
      console.error('[bid-clock] 写入配置失败:', err.message);
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
      if (data[key] === value) return;
      data[key] = value;
      schedule();
    },
    setBidTime(value) {
      const next = isBidTime(value) ? normalizeBidTime(value) : null;
      if (data.bidTime === next) return;
      data.bidTime = next;
      schedule();
    },
    setHeight(value) {
      const next = clampHeight(value, data.height);
      if (data.height === next) return;
      data.height = next;
      schedule();
    },
    setAspect(value) {
      const next = clampAspect(value, data.aspect);
      if (data.aspect === next) return;
      data.aspect = next;
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
  sanitize,
  DEFAULTS
};
