'use strict';

/**
 * 主进程
 *
 * 职责：
 *   1. 悬浮钟窗口：无边框 + 背景透明 + 永远置顶，只显示 HH:MM:SS；
 *   2. 设置窗口：09:30 / 14:00 两个预设 + 小时/分钟自定义，选完即用并记到配置里；
 *   3. 每秒对齐到整秒推一次时间给界面，到开标时间自动退出；
 *   4. 拖窗口移动、拖右下角等比缩放（宽度 = 高度 × 宽高比）。
 */

const path = require('path');
const {
  app,
  BrowserWindow,
  Menu,
  Tray,
  dialog,
  ipcMain,
  screen,
  nativeImage
} = require('electron');

const { createConfigStore } = require('./config');
const { createTrayImage } = require('./tray-icon');
const {
  BID_TIMES,
  DUE_FLASH_MS,
  formatClock,
  formatDate,
  formatDuration,
  isBidTime,
  normalizeBidTime,
  nextTickDelay,
  phaseFor,
  resolveTarget
} = require('./schedule');
const {
  PRESET_HEIGHTS,
  clampAspect,
  clampHeight,
  defaultPosition,
  heightFromDrag,
  keepOnScreen,
  sizeForHeight
} = require('./geometry');

const APP_AUTHOR = 'CAI JIAXING';
const APP_USER_MODEL_ID = 'com.cline.bidclock';
const MARGIN = 12;
const POLL_INTERVAL_MS = 16;
const DRAG_SAFETY_MS = 60 * 1000;
const SETUP_SIZE = { width: 460, height: 440 };
const IS_DEV = process.argv.includes('--dev');

let config = null;
let clockWin = null;
let setupWin = null;
let tray = null;
let quitting = false;

/** 悬浮钟渲染进程已经量好宽高比、可以显示了 */
let clockReady = false;
/** 打开设置窗口之前悬浮钟是不是可见的（关掉设置后要还原） */
let clockWasVisible = false;
/** 待发给设置窗口的提示（比如「12:29 今天已经过了」），窗口加载完再发 */
let pendingSetupWarning = null;

let tickTimer = null;
let exitTimer = null;

let dragState = null; // { win, dx, dy }
let dragTimer = null;
let dragSafetyTimer = null;

let resizeState = null; // { win, startX, startY, startHeight, aspect }
let resizeTimer = null;
let resizeSafetyTimer = null;

const WEB_PREFERENCES = {
  preload: path.join(__dirname, 'preload.js'),
  contextIsolation: true,
  nodeIntegration: false,
  sandbox: true,
  spellcheck: false,
  backgroundThrottling: false,
  devTools: IS_DEV
};

/* ------------------------------------------------------------------ *
 * 小工具
 * ------------------------------------------------------------------ */

function windowBounds(win) {
  const [x, y] = win.getPosition();
  const [width, height] = win.getContentSize();
  return { x, y, width, height };
}

function contentSize(win) {
  const [width, height] = win.getContentSize();
  return { width, height };
}

/** 放大窗口后右/下边可能跑到屏幕外，拉回来 */
function keepClockOnScreen() {
  if (!clockWin || clockWin.isDestroyed()) return;
  const bounds = windowBounds(clockWin);
  const { workArea } = screen.getDisplayMatching(bounds);
  const next = keepOnScreen(bounds, workArea);
  if (next.x !== bounds.x || next.y !== bounds.y) {
    clockWin.setPosition(next.x, next.y, false);
  }
}

function applyAlwaysOnTop() {
  if (!clockWin || clockWin.isDestroyed()) return;
  const enabled = Boolean(config.get('alwaysOnTop'));
  // 'screen-saver' 级别可以压在大部分全屏窗口之上
  clockWin.setAlwaysOnTop(enabled, 'screen-saver');
  try {
    clockWin.setVisibleOnAllWorkspaces(enabled, { visibleOnFullScreen: true });
  } catch (err) {
    /* 平台不支持时忽略 */
  }
}

/* ------------------------------------------------------------------ *
 * 悬浮钟窗口
 * ------------------------------------------------------------------ */

function createClockWindow() {
  if (clockWin && !clockWin.isDestroyed()) return clockWin;

  const aspect = clampAspect(config.get('aspect'));
  const size = sizeForHeight(clampHeight(config.get('height')), aspect);
  const saved = config.getWindowPosition();
  const workArea = screen.getPrimaryDisplay().workArea;
  const position = saved || defaultPosition(workArea, size, MARGIN);

  clockWin = new BrowserWindow({
    x: position.x,
    y: position.y,
    width: size.width,
    height: size.height,
    useContentSize: true,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    resizable: true,
    movable: true,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    hasShadow: false,
    show: false,
    title: '开标时间',
    webPreferences: WEB_PREFERENCES
  });

  applyAlwaysOnTop();
  clockWin.loadFile(path.join(__dirname, 'renderer', 'clock', 'index.html'));

  clockWin.on('moved', () => persistClockPosition());
  clockWin.on('resized', () => persistClockHeight());

  // 关掉窗口（Alt+F4）等于藏起来，托盘还在
  clockWin.on('close', (event) => {
    if (quitting) return;
    event.preventDefault();
    clockWin.hide();
  });

  clockWin.on('closed', () => {
    clockWin = null;
    clockReady = false;
  });

  if (IS_DEV) clockWin.webContents.openDevTools({ mode: 'detach' });

  return clockWin;
}

function persistClockPosition() {
  if (!clockWin || clockWin.isDestroyed()) return;
  // 拖动过程中每帧都会触发 moved，等松手时再统一保存
  if (dragState) return;
  const [x, y] = clockWin.getPosition();
  config.setWindowPosition(x, y);
}

function persistClockHeight() {
  if (!clockWin || clockWin.isDestroyed()) return;
  if (resizeState) return;
  const { height } = contentSize(clockWin);
  config.setHeight(height);
}

/** 按高度设置窗口大小（宽度是算出来的，所以横宽比永远不变） */
function applyClockHeight(height, options = {}) {
  if (!clockWin || clockWin.isDestroyed()) return;
  const aspect = clampAspect(config.get('aspect'));
  const size = sizeForHeight(clampHeight(height), aspect);
  const current = contentSize(clockWin);
  if (size.width === current.width && size.height === current.height) return;

  clockWin.setContentSize(size.width, size.height);
  keepClockOnScreen();
  if (options.persist !== false) config.setHeight(size.height);
}

/**
 * 渲染进程量出真实宽高比之后：定尺寸 → 显示 → 立刻推一次时间。
 * 顺序很重要，这样窗口出现时就是最终大小，不会先闪一下错误尺寸。
 */
function handleClockReady(payload) {
  if (!clockWin || clockWin.isDestroyed()) return;

  const aspect = clampAspect(payload && payload.aspect);
  config.setAspect(aspect);

  const size = sizeForHeight(clampHeight(config.get('height')), aspect);
  clockWin.setContentSize(size.width, size.height);
  try {
    // 交给系统：用户直接拖窗口边缘时也保持同样的比例
    clockWin.setAspectRatio(aspect);
  } catch (err) {
    /* 平台不支持就只靠自绘手柄 */
  }

  keepClockOnScreen();
  persistClockPosition();

  console.log(`[bid-clock] 悬浮钟就绪：宽高比 ${aspect.toFixed(3)}，尺寸 ${size.width}x${size.height}`);

  clockReady = true;
  clockWin.show();
  applyAlwaysOnTop();
  sendTick();
}

function toggleClockWindow() {
  if (!clockWin || clockWin.isDestroyed()) {
    // 没有「今天还能等」的时间就先让用户选，别开一个永远不退出的钟
    if (!hasUsableBidTime()) {
      openSetupForChoice();
      return;
    }
    createClockWindow();
    return;
  }
  if (clockWin.isVisible()) {
    clockWin.hide();
  } else {
    clockWin.show();
    applyAlwaysOnTop();
  }
}

function resetClockPosition() {
  if (!clockWin || clockWin.isDestroyed()) return;
  const size = contentSize(clockWin);
  const workArea = screen.getPrimaryDisplay().workArea;
  const position = defaultPosition(workArea, size, MARGIN);
  clockWin.setPosition(position.x, position.y, false);
  persistClockPosition();
}

/* ------------------------------------------------------------------ *
 * 设置窗口（09:30 / 14:00 两个预设 + 小时/分钟 自定义）
 * ------------------------------------------------------------------ */

function sendSetupState() {
  if (!setupWin || setupWin.isDestroyed()) return;

  const now = new Date();
  const bidTime = config.get('bidTime');
  const target = bidTime ? resolveTarget(bidTime, now) : null;

  setupWin.webContents.send('setup:state', {
    options: BID_TIMES,
    bidTime,
    due: target ? target.due : false,
    remainingMs: target && !target.due ? target.remainingMs : null,
    remainingText: target && !target.due ? formatDuration(target.remainingMs) : null,
    now: formatClock(now),
    today: formatDate(now),
    // 比如「12:31 今天已经过了，换一个更晚的时间就能继续。」
    warning: takeSetupWarning()
  });
}

/** 打开或唤醒设置窗口；顺手先把悬浮钟藏起来，免得两块窗口叠在一起 */
function openSetup() {
  // 已经开着就直接抬到前面，别再动 clockWasVisible（否则会丢掉「原本是显示的」这个状态）
  if (setupWin && !setupWin.isDestroyed()) {
    setupWin.show();
    setupWin.focus();
    sendSetupState();
    return setupWin;
  }

  clockWasVisible = Boolean(clockWin && !clockWin.isDestroyed() && clockWin.isVisible());
  if (clockWasVisible) clockWin.hide();

  setupWin = new BrowserWindow({
    width: SETUP_SIZE.width,
    height: SETUP_SIZE.height,
    useContentSize: true,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    resizable: false,
    movable: true,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    hasShadow: false,
    center: true,
    show: false,
    title: '选择开标时间',
    webPreferences: WEB_PREFERENCES
  });

  setupWin.loadFile(path.join(__dirname, 'renderer', 'setup', 'index.html'));

  setupWin.once('ready-to-show', () => {
    if (!setupWin || setupWin.isDestroyed()) return;
    setupWin.show();
    setupWin.focus();
    sendSetupState();
  });

  setupWin.on('closed', () => {
    setupWin = null;
    restoreClockAfterSetup();
    // 关掉设置窗口时如果手上还没有「今天能等」的时间，就没东西可显示了，直接退出
    if (!quitting && !hasUsableBidTime()) quitApp();
  });

  if (IS_DEV) setupWin.webContents.openDevTools({ mode: 'detach' });

  return setupWin;
}

function closeSetup() {
  if (setupWin && !setupWin.isDestroyed()) setupWin.close();
}

function restoreClockAfterSetup() {
  if (!clockWasVisible) return;
  clockWasVisible = false;
  if (clockWin && !clockWin.isDestroyed()) {
    clockWin.show();
    applyAlwaysOnTop();
  }
}

/**
 * 用户选好了开标时间（预设按钮或自定义下拉都走这里）。
 *
 * 如果选的时间今天已经过了，就退回设置窗口并提示一句 —— 不采纳、不改配置、
 * 也不退出程序（原来这里会弹框然后退出，用户重开就再也改不了时间了）。
 */
function chooseBidTime(value) {
  if (!isBidTime(value)) {
    console.warn('[bid-clock] 忽略无效的开标时间:', value);
    return;
  }

  const bidTime = normalizeBidTime(value);
  const target = resolveTarget(bidTime);

  // 今天已经过了：不采纳、不改配置、更不退出 —— 回设置窗口让用户换一个更晚的
  if (target && target.due) {
    refreshTray();
    openSetupForChoice(bidTime);
    return;
  }

  config.setBidTime(bidTime);

  clockWasVisible = false; // 选完一定要看到钟
  const win = createClockWindow();
  closeSetup();

  if (clockReady && win && !win.isDestroyed()) {
    win.show();
    applyAlwaysOnTop();
  }

  armSchedule();
  refreshTray();
}

/* ------------------------------------------------------------------ *
 * 计时：每秒推一次界面，到点自动退出
 * ------------------------------------------------------------------ */

function sendTick(payload) {
  const now = new Date();
  const target = resolveTarget(config.get('bidTime'), now);

  const data = payload || (target
    ? {
      text: formatClock(now),
      phase: phaseFor(target.targetMs - now.getTime()),
      remainingMs: target.targetMs - now.getTime(),
      bidTime: target.bidTime
    }
    : { text: formatClock(now), phase: 'normal', remainingMs: null, bidTime: null });

  if (clockWin && !clockWin.isDestroyed()) {
    clockWin.webContents.send('clock:tick', data);
  }
  updateTrayTooltip();
}

function stepTick() {
  tickTimer = null;

  const now = new Date();
  const target = resolveTarget(config.get('bidTime'), now);
  const remainingMs = target ? target.targetMs - now.getTime() : null;

  sendTick({
    text: formatClock(now),
    phase: target ? phaseFor(remainingMs) : 'normal',
    remainingMs,
    bidTime: target ? target.bidTime : null
  });

  if (target && remainingMs <= 0) {
    scheduleExit(target);
    return;
  }

  tickTimer = setTimeout(stepTick, nextTickDelay());
}

function stopTimers() {
  if (tickTimer) {
    clearTimeout(tickTimer);
    tickTimer = null;
  }
  if (exitTimer) {
    clearTimeout(exitTimer);
    exitTimer = null;
  }
}

/** 开始走秒；如果开标时间今天已经过了，就直接收尾 */
function armSchedule() {
  stopTimers();

  const bidTime = config.get('bidTime');
  if (!bidTime) return;

  const target = resolveTarget(bidTime);
  if (!target) return;

  if (target.due) {
    // 保险：走到这儿说明有人拿着一个今天已经过的时间来武装计时
    openSetupForChoice(target.bidTime);
    return;
  }

  console.log(
    `[bid-clock] 开标时间 ${target.bidTime}，还有 ${formatDuration(target.remainingMs)}，到点自动退出`
  );
  stepTick();
  refreshTray();
}

/**
 * 到点了：界面已经由最后那次 stepTick 打上 'due' 状态（显示开标时刻本身），
 * 亮一小会儿再退出 —— 让用户确实看到「09:30:00 到了」，而不是感觉提前消失。
 */
function scheduleExit(target) {
  if (exitTimer) return;
  console.log(`[bid-clock] 已到开标时间 ${target.bidTime}，${DUE_FLASH_MS}ms 后自动退出`);

  exitTimer = setTimeout(() => {
    exitTimer = null;
    quitApp();
  }, DUE_FLASH_MS);
}

function quitApp() {
  quitting = true;
  stopTimers();
  app.quit();
}

/**
 * 「今天已经过了 / 还没选过」时该走的岔路口 —— 绝不能把用户卡死：
 *   1. 不改配置、不退出程序（原来这里弹一个只能「确定并退出」的框，用户重开也进不来）；
 *   2. 打开设置窗口（没开就开、开着就抬到前面），并在里面提示一句「换一个更晚的」。
 *
 * @param {string} [expiredBidTime] 刚被选中的、今天已经过了的时间（不传就用配置里的）
 */
function openSetupForChoice(expiredBidTime) {
  const bidTime = expiredBidTime || config.get('bidTime');
  const target = bidTime ? resolveTarget(bidTime) : null;

  if (target && target.due) {
    pendingSetupWarning = {
      bidTime: target.bidTime,
      message: `${target.bidTime} 今天已经过了，换一个更晚的时间就能继续。`
    };
  }

  // 提示不单独发消息，而是跟着 sendSetupState 一起走 —— 这样不用担心
  // 「窗口还没加载完、消息丢了」这种时序问题（无论新开还是已开，state 都一定会发）。
  openSetup();
}

/** 取出待发的提示（取过就清空，避免下次开窗口又冒出来） */
function takeSetupWarning() {
  if (!pendingSetupWarning) return null;
  const { message } = pendingSetupWarning;
  pendingSetupWarning = null;
  return message;
}

/** 配置里有没有「今天还能等」的开标时间 */
function hasUsableBidTime() {
  const bidTime = config.get('bidTime');
  if (!bidTime) return false;

  const target = resolveTarget(bidTime);
  return Boolean(target) && !target.due;
}

/* ------------------------------------------------------------------ *
 * 托盘 / 菜单
 * ------------------------------------------------------------------ */

function buildTrayTooltip() {
  const bidTime = config.get('bidTime');
  if (!bidTime) return '开标时钟 · 还没选择开标时间';

  const target = resolveTarget(bidTime);
  if (!target) return '开标时钟';
  if (target.due) return `开标时钟 · ${bidTime} 今天已过，右键可重选`;
  return `开标时钟 · 距 ${bidTime} 还有 ${formatDuration(target.remainingMs)}`;
}

function updateTrayTooltip() {
  if (!tray || tray.isDestroyed()) return;
  tray.setToolTip(buildTrayTooltip());
}

function createTray() {
  try {
    tray = new Tray(createTrayImage(nativeImage));
    tray.setToolTip(buildTrayTooltip());
    tray.setContextMenu(buildMenu());
    tray.on('click', () => toggleClockWindow());
  } catch (err) {
    // 托盘建不出来也应该能看时间，只是少了个入口
    console.error('[bid-clock] 创建托盘图标失败:', err.message);
  }
}

function refreshTray() {
  if (!tray || tray.isDestroyed()) return;
  tray.setContextMenu(buildMenu());
  tray.setToolTip(buildTrayTooltip());
}

/** 右键菜单和托盘菜单共用同一份 */
function buildMenu() {
  const bidTime = config.get('bidTime');
  const target = bidTime ? resolveTarget(bidTime) : null;
  const visible = Boolean(clockWin && !clockWin.isDestroyed() && clockWin.isVisible());
  const height = clockReady && clockWin && !clockWin.isDestroyed()
    ? contentSize(clockWin).height
    : clampHeight(config.get('height'));

  const presetItems = [
    { label: '小', value: PRESET_HEIGHTS.small },
    { label: '中', value: PRESET_HEIGHTS.medium },
    { label: '大', value: PRESET_HEIGHTS.large }
  ].map((preset) => ({
    label: preset.label,
    type: 'radio',
    checked: height === preset.value,
    click: () => applyClockHeight(preset.value)
  }));

  const status = !bidTime
    ? '还没选择开标时间'
    : target && !target.due
      ? `距 ${target.bidTime} 还有 ${formatDuration(target.remainingMs)}`
      : `${target ? target.bidTime : bidTime} 今天已过（请重新选择）`;

  // 当前时间不在两个预设里，就是自定义的
  const isCustom = Boolean(bidTime) && !BID_TIMES.includes(bidTime);

  return Menu.buildFromTemplate([
    { label: '开标时间', enabled: false },
    ...BID_TIMES.map((time) => ({
      label: `${time}${time === '09:30' ? '（上午）' : '（下午）'}`,
      type: 'radio',
      checked: bidTime === time,
      click: () => chooseBidTime(time)
    })),
    {
      label: `自定义时间…${isCustom ? `（当前 ${bidTime}）` : ''}`,
      type: 'radio',
      checked: isCustom,
      click: () => openSetup()
    },
    { type: 'separator' },
    { label: status, enabled: false },
    { type: 'separator' },
    { label: '打开设置窗口…', click: () => openSetup() },
    { label: visible ? '隐藏悬浮钟' : '显示悬浮钟', click: () => toggleClockWindow() },
    { label: '窗口大小', submenu: presetItems },
    { label: '重置位置（右上角）', click: () => resetClockPosition() },
    {
      label: '始终置顶',
      type: 'checkbox',
      checked: Boolean(config.get('alwaysOnTop')),
      click: (item) => {
        config.set('alwaysOnTop', item.checked);
        applyAlwaysOnTop();
        refreshTray();
      }
    },
    { type: 'separator' },
    { label: `关于（作者 ${APP_AUTHOR}）`, click: () => showAbout() },
    { label: '退出', click: () => quitApp() }
  ]);
}

function popupMenu(win) {
  const menu = buildMenu();
  if (win && !win.isDestroyed()) {
    menu.popup({ window: win });
    return;
  }
  menu.popup();
}

function showAbout() {
  const options = {
    type: 'info',
    title: '关于',
    message: '开标时钟',
    detail: [
      `版本　　　　${app.getVersion()}`,
      `制作人　　　${APP_AUTHOR}`,
      '',
      '置顶透明的悬浮钟：只显示当前时间（时:分:秒），',
      '到选定的开标时间（09:30 / 14:00，或自己挑一个）自动退出。',
      '',
      '拖动窗口可移动；拖右下角手柄可等比缩放。',
      '',
      `Electron ${process.versions.electron}　Node ${process.versions.node}`
    ].join('\n'),
    buttons: ['确定'],
    defaultId: 0,
    noLink: true
  };

  const parent = [setupWin, clockWin].find((win) => win && !win.isDestroyed() && win.isVisible());
  if (parent) {
    dialog.showMessageBox(parent, options);
    return;
  }
  dialog.showMessageBox(options);
}

/* ------------------------------------------------------------------ *
 * 拖动 / 等比缩放
 * ------------------------------------------------------------------ */

function startDrag(win) {
  if (!win || win.isDestroyed()) return;
  stopDrag();

  const cursor = screen.getCursorScreenPoint();
  const [x, y] = win.getPosition();
  dragState = { win, dx: cursor.x - x, dy: cursor.y - y };

  dragTimer = setInterval(() => {
    if (!dragState || dragState.win.isDestroyed()) {
      stopDrag();
      return;
    }
    const point = screen.getCursorScreenPoint();
    dragState.win.setPosition(point.x - dragState.dx, point.y - dragState.dy, false);
  }, POLL_INTERVAL_MS);

  dragSafetyTimer = setTimeout(() => stopDrag(), DRAG_SAFETY_MS);
}

function stopDrag() {
  if (dragTimer) {
    clearInterval(dragTimer);
    dragTimer = null;
  }
  if (dragSafetyTimer) {
    clearTimeout(dragSafetyTimer);
    dragSafetyTimer = null;
  }
  if (!dragState) return;

  const { win } = dragState;
  dragState = null;
  if (win && !win.isDestroyed() && win === clockWin) persistClockPosition();
}

/**
 * 拖右下角手柄：16ms 轮询一次光标，按位移换算出新高度。
 * 宽度由高度乘宽高比得到，所以怎么拖都不会变形。
 */
function startResize(win) {
  if (!win || win.isDestroyed() || win !== clockWin) return;
  stopResize({ persist: false });

  const point = screen.getCursorScreenPoint();
  resizeState = {
    win,
    startX: point.x,
    startY: point.y,
    startHeight: contentSize(win).height,
    aspect: clampAspect(config.get('aspect'))
  };

  resizeTimer = setInterval(() => {
    if (!resizeState || resizeState.win.isDestroyed()) {
      stopResize({ persist: false });
      return;
    }
    const cursor = screen.getCursorScreenPoint();
    const height = heightFromDrag({
      startHeight: resizeState.startHeight,
      dx: cursor.x - resizeState.startX,
      dy: cursor.y - resizeState.startY,
      aspect: resizeState.aspect
    });
    applyClockHeight(height, { persist: false });
  }, POLL_INTERVAL_MS);

  resizeSafetyTimer = setTimeout(() => stopResize({ persist: true }), DRAG_SAFETY_MS);
}

function stopResize(options = {}) {
  if (resizeTimer) {
    clearInterval(resizeTimer);
    resizeTimer = null;
  }
  if (resizeSafetyTimer) {
    clearTimeout(resizeSafetyTimer);
    resizeSafetyTimer = null;
  }
  if (!resizeState) return;

  const { win } = resizeState;
  resizeState = null;
  if (options.persist && win && !win.isDestroyed()) {
    config.setHeight(contentSize(win).height);
  }
}

/* ------------------------------------------------------------------ *
 * 渲染进程 IPC
 * ------------------------------------------------------------------ */

function registerIpc() {
  ipcMain.on('clock:ready', (event, payload) => {
    if (!clockWin || event.sender !== clockWin.webContents) return;
    handleClockReady(payload);
  });

  ipcMain.on('clock:menu', (event) => {
    popupMenu(BrowserWindow.fromWebContents(event.sender));
  });

  ipcMain.on('setup:choose', (event, bidTime) => {
    if (!setupWin || event.sender !== setupWin.webContents) return;
    chooseBidTime(bidTime);
  });

  ipcMain.on('setup:close', (event) => {
    if (!setupWin || event.sender !== setupWin.webContents) return;
    closeSetup();
  });

  ipcMain.on('win:drag-start', (event) => startDrag(BrowserWindow.fromWebContents(event.sender)));
  ipcMain.on('win:drag-end', () => stopDrag());
  ipcMain.on('clock:resize-start', (event) => startResize(BrowserWindow.fromWebContents(event.sender)));
  ipcMain.on('clock:resize-end', () => stopResize({ persist: true }));
}

/* ------------------------------------------------------------------ *
 * 诊断（--diagnose）：把配置和算出来的目标时间写成 JSON 后退出
 * ------------------------------------------------------------------ */

function writeDiagnostics() {
  const fs = require('fs');
  const os = require('os');

  const bidTime = config.get('bidTime');
  const target = bidTime ? resolveTarget(bidTime) : null;

  const info = {
    at: new Date().toISOString(),
    version: app.getVersion(),
    packaged: app.isPackaged,
    platform: `${process.platform} ${process.arch}`,
    electron: process.versions.electron,
    node: process.versions.node,
    execPath: process.execPath,
    userData: app.getPath('userData'),
    configFile: config.file,
    bidTime,
    target: target ? target.target.toISOString() : null,
    due: target ? target.due : null,
    remainingMs: target ? target.remainingMs : null,
    remainingText: target && !target.due ? formatDuration(target.remainingMs) : null,
    aspect: config.get('aspect'),
    height: config.get('height'),
    window: config.getWindowPosition()
  };

  const file = path.join(os.tmpdir(), 'bid-clock-diagnose.json');
  fs.writeFileSync(file, `${JSON.stringify(info, null, 2)}\n`, 'utf8');
  return { file, info };
}

/* ------------------------------------------------------------------ *
 * 生命周期
 * ------------------------------------------------------------------ */

function boot() {
  app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');
  app.setAppUserModelId(APP_USER_MODEL_ID);

  app.whenReady().then(() => {
    config = createConfigStore(app.getPath('userData'));

    // 诊断模式：不建窗口，只写环境信息
    if (process.argv.includes('--diagnose')) {
      const { file, info } = writeDiagnostics();
      console.log(`diagnostics written to ${file}`);
      console.log(JSON.stringify(info, null, 2));
      app.exit(0);
      return;
    }

    const bidTime = config.get('bidTime');
    const target = bidTime ? resolveTarget(bidTime) : null;

    createTray();
    registerIpc();

    if (hasUsableBidTime()) {
      // 今天还能等 → 直接进悬浮钟
      createClockWindow();
      armSchedule();
      return;
    }

    // 没选过、或者上次选的时间今天已经过了 → 打开设置窗口让用户选（不弹框、不退出）
    if (bidTime) {
      console.log(`[bid-clock] ${bidTime} 今天已经过了（现在 ${formatClock(new Date())}），打开设置窗口重新选择`);
    }
    openSetupForChoice();
  });

  app.on('second-instance', () => {
    if (clockWin && !clockWin.isDestroyed()) {
      clockWin.show();
      applyAlwaysOnTop();
      return;
    }
    if (!config) return;

    // 又点了一次图标：有可等的时间就显示悬浮钟，否则回设置窗口
    if (hasUsableBidTime()) createClockWindow();
    else openSetupForChoice();
  });

  // 托盘常驻：关掉窗口不等于退出
  app.on('window-all-closed', () => {});

  app.on('before-quit', () => {
    quitting = true;
    stopTimers();
  });

  app.on('will-quit', () => {
    if (config) config.flush();
  });
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  boot();
}
