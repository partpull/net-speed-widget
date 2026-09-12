'use strict';

const path = require('path');
const {
  app,
  BrowserWindow,
  Menu,
  Tray,
  dialog,
  ipcMain,
  screen,
  globalShortcut,
  nativeImage
} = require('electron');

const { createConfigStore, clampInterval } = require('./config');
const { SpeedMonitor } = require('./speed-monitor');
const { createTrayImage } = require('./tray-icon');

const DEFAULT_WIDTH = 196;
const DEFAULT_HEIGHT = 40;
const APP_AUTHOR = 'CAI JIAXING';
const MIN_WIDTH = 80;
const MAX_WIDTH = 600;
const MIN_HEIGHT = 20;
const MAX_HEIGHT = 200;
const EDGE_MARGIN = 12;

let config = null;
let win = null;
let tray = null;
let monitor = null;
let quitting = false;
let dragTimer = null;
let dragOffset = null;
let dragSafetyTimer = null;

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

/* ------------------------------------------------------------------ *
 * 窗口
 * ------------------------------------------------------------------ */

function getInitialBounds() {
  const saved = config.getWindowPosition();
  if (saved) {
    return { x: saved.x, y: saved.y, width: DEFAULT_WIDTH, height: DEFAULT_HEIGHT };
  }
  const { workArea } = screen.getPrimaryDisplay();
  return {
    x: workArea.x + workArea.width - DEFAULT_WIDTH - EDGE_MARGIN,
    y: workArea.y + EDGE_MARGIN,
    width: DEFAULT_WIDTH,
    height: DEFAULT_HEIGHT
  };
}

function createWindow() {
  const bounds = getInitialBounds();

  win = new BrowserWindow({
    ...bounds,
    useContentSize: true,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    resizable: false,
    movable: true,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    hasShadow: false,
    show: false,
    title: '网速',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
      backgroundThrottling: false,
      devTools: process.argv.includes('--dev')
    }
  });

  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  win.once('ready-to-show', () => {
    applyAlwaysOnTop();
    applyClickThrough();
    win.show();
  });

  win.on('moved', () => persistPosition());

  win.on('close', (event) => {
    if (quitting) return;
    event.preventDefault();
    win.hide();
  });

  win.on('closed', () => {
    win = null;
  });

  if (process.argv.includes('--dev')) {
    win.webContents.openDevTools({ mode: 'detach' });
  }
}

function keepOnScreen() {
  if (!win || win.isDestroyed()) return;
  const current = win.getBounds();
  const display = screen.getDisplayMatching(current);
  const { workArea } = display;

  const width = current.width;
  const height = current.height;
  const maxX = workArea.x + workArea.width - width;
  const maxY = workArea.y + workArea.height - height;

  const x = clamp(current.x, workArea.x, Math.max(workArea.x, maxX));
  const y = clamp(current.y, workArea.y, Math.max(workArea.y, maxY));

  if (x !== current.x || y !== current.y) {
    win.setPosition(x, y, false);
  }
}

function persistPosition() {
  if (!win || win.isDestroyed()) return;
  // 拖拽过程中每帧都会触发 moved，等松手时再统一保存
  if (dragOffset) return;
  const [x, y] = win.getPosition();
  config.setWindowPosition(x, y);
}

function resetPosition() {
  if (!win || win.isDestroyed()) return;
  const { workArea } = screen.getPrimaryDisplay();
  const [width, height] = win.getSize();
  win.setPosition(
    workArea.x + workArea.width - width - EDGE_MARGIN,
    workArea.y + EDGE_MARGIN,
    false
  );
  persistPosition();
}

function showWindow() {
  if (!win || win.isDestroyed()) return;
  win.show();
  applyAlwaysOnTop();
  applyClickThrough();
}

function toggleWindow() {
  if (!win || win.isDestroyed()) return;
  if (win.isVisible()) win.hide();
  else showWindow();
}

/* ------------------------------------------------------------------ *
 * 置顶 / 鼠标穿透 / 开机自启
 * ------------------------------------------------------------------ */

function applyAlwaysOnTop() {
  if (!win || win.isDestroyed()) return;
  const enabled = Boolean(config.get('alwaysOnTop'));
  // 'screen-saver' 级别可以压在大部分全屏窗口之上
  win.setAlwaysOnTop(enabled, 'screen-saver');
  try {
    win.setVisibleOnAllWorkspaces(enabled, { visibleOnFullScreen: true });
  } catch (err) {
    /* 平台不支持时忽略 */
  }
}

function applyClickThrough() {
  if (!win || win.isDestroyed()) return;
  const enabled = Boolean(config.get('clickThrough'));
  // forward: true 让窗口仍能收到 mousemove，方便以后扩展 hover 效果
  win.setIgnoreMouseEvents(enabled, { forward: true });
}

/**
 * 开机自启应该指向哪个可执行文件。
 *
 * 绿色版（electron-builder 的 portable 目标）每次运行都会把自己解压到
 * `%TEMP%\<随机目录>` 再启动，所以 process.execPath 指向的是那份**临时** exe，
 * 而那个目录在退出后会被删掉 —— 拿它去注册开机启动项，下次开机必然失效。
 *
 * 这种情况必须用 PORTABLE_EXECUTABLE_FILE（用户双击的启动器 exe 的真实位置）。
 */
function resolveLaunchTarget() {
  const portableExe = process.env.PORTABLE_EXECUTABLE_FILE;
  if (portableExe) {
    return { path: portableExe, args: [] };
  }
  return {
    path: process.execPath,
    args: app.isPackaged ? [] : [path.resolve(__dirname, '..')]
  };
}

function applyLaunchAtLogin(enabled) {
  const want = Boolean(enabled);
  if (!app.isPackaged && !want) return; // 开发模式下只处理「开启」

  const target = resolveLaunchTarget();
  try {
    app.setLoginItemSettings({
      openAtLogin: want,
      path: target.path,
      args: target.args
    });
  } catch (err) {
    console.error('[net-speed-widget] 设置开机自启失败:', err.message);
  }
}

/**
 * `--diagnose`：把运行环境信息写成 JSON 落到临时目录后退出。
 *
 * 主要给绿色版排错用 —— 它的进程实际跑在临时目录里，光看界面或进程列表
 * 很难判断是哪一份 exe 在跑、自启会注册到哪儿。
 */
function writeDiagnostics() {
  const fs = require('fs');
  const os = require('os');
  const target = resolveLaunchTarget();

  const info = {
    at: new Date().toISOString(),
    version: app.getVersion(),
    packaged: app.isPackaged,
    platform: `${process.platform} ${process.arch}`,
    electron: process.versions.electron,
    node: process.versions.node,
    execPath: process.execPath,
    isPortable: Boolean(process.env.PORTABLE_EXECUTABLE_FILE),
    portableExecutableFile: process.env.PORTABLE_EXECUTABLE_FILE || null,
    portableExecutableDir: process.env.PORTABLE_EXECUTABLE_DIR || null,
    portableExecutableAppFilename: process.env.PORTABLE_EXECUTABLE_APP_FILENAME || null,
    launchAtLoginTarget: target.path,
    launchAtLoginArgs: target.args,
    userData: app.getPath('userData')
  };

  const file = path.join(os.tmpdir(), 'net-speed-widget-diagnose.json');
  fs.writeFileSync(file, `${JSON.stringify(info, null, 2)}\n`, 'utf8');
  return { file, info };
}

/* ------------------------------------------------------------------ *
 * 托盘
 * ------------------------------------------------------------------ */

function createTray() {
  try {
    tray = new Tray(createTrayImage(nativeImage));
  } catch (err) {
    console.error('[net-speed-widget] 创建托盘图标失败:', err.message);
    return;
  }
  tray.setToolTip('网速悬浮窗');
  tray.on('click', () => toggleWindow());
  tray.on('right-click', () => popupMenu());
  refreshTrayMenu();
}

function refreshTrayMenu() {
  if (!tray || tray.isDestroyed()) return;
  tray.setContextMenu(buildMenu());
}

function popupMenu() {
  const menu = buildMenu();
  if (win && !win.isDestroyed()) {
    menu.popup({ window: win });
    return;
  }
  menu.popup();
}

function buildMenu() {
  const intervals = [500, 1000, 2000, 5000];
  return Menu.buildFromTemplate([
    {
      label: win && win.isVisible() ? '隐藏悬浮窗' : '显示悬浮窗',
      click: () => toggleWindow()
    },
    { type: 'separator' },
    {
      label: '始终置顶',
      type: 'checkbox',
      checked: Boolean(config.get('alwaysOnTop')),
      click: (item) => {
        config.set('alwaysOnTop', item.checked);
        applyAlwaysOnTop();
      }
    },
    {
      label: '鼠标穿透（点不到窗口）',
      type: 'checkbox',
      checked: Boolean(config.get('clickThrough')),
      click: (item) => {
        config.set('clickThrough', item.checked);
        applyClickThrough();
      }
    },
    {
      label: '开机自启动',
      type: 'checkbox',
      checked: Boolean(config.get('launchAtLogin')),
      click: (item) => {
        config.set('launchAtLogin', item.checked);
        applyLaunchAtLogin(item.checked);
      }
    },
    { type: 'separator' },
    {
      label: '刷新间隔',
      submenu: intervals.map((ms) => ({
        label: ms >= 1000 ? `${ms / 1000} 秒` : `${ms} 毫秒`,
        type: 'radio',
        checked: clampInterval(config.get('intervalMs')) === ms,
        click: () => {
          config.set('intervalMs', ms);
          monitor.setIntervalMs(ms);
          refreshTrayMenu();
        }
      }))
    },
    { label: '重置位置（右上角）', click: () => resetPosition() },
    { type: 'separator' },
    { label: `关于（作者 ${APP_AUTHOR}）`, click: () => showAbout() },
    {
      label: '退出',
      click: () => {
        quitting = true;
        app.quit();
      }
    }
  ]);
}

/**
 * 关于对话框：右键菜单 / 托盘菜单里的「关于」入口。
 * 窗口还活着就挂到窗口上（会显示在悬浮窗上方），否则弹出独立对话框。
 */
function showAbout() {
  const options = {
    type: 'info',
    title: '关于',
    message: '网速悬浮窗',
    detail: [
      `版本　　　　${app.getVersion()}`,
      `制作人　　　${APP_AUTHOR}`,
      '',
      '一个置顶的小挂件，只显示下载 / 上传速度。',
      '',
      `Electron ${process.versions.electron}　Node ${process.versions.node}`
    ].join('\n'),
    buttons: ['确定'],
    defaultId: 0,
    noLink: true
  };

  if (win && !win.isDestroyed()) {
    dialog.showMessageBox(win, options);
    return;
  }
  dialog.showMessageBox(options);
}

/* ------------------------------------------------------------------ *
 * 测速
 * ------------------------------------------------------------------ */

function sendToRenderer(channel, payload) {
  if (!win || win.isDestroyed()) return;
  win.webContents.send(channel, payload);
}

function startMonitoring() {
  monitor = new SpeedMonitor({
    intervalMs: config.get('intervalMs'),
    smoothing: config.get('smoothing')
  });

  monitor.on('sample', (sample) => sendToRenderer('speed:sample', sample));
  monitor.on('state', (state) => sendToRenderer('speed:state', state));
  monitor.on('failure', ({ reason }) => {
    console.warn('[net-speed-widget] 数据源失败:', reason);
  });
  monitor.start();
}

/* ------------------------------------------------------------------ *
 * 渲染进程 IPC
 * ------------------------------------------------------------------ */

function registerIpc() {
  ipcMain.on('widget:menu', () => popupMenu());

  ipcMain.on('widget:size', (event, payload) => {
    if (!win || win.isDestroyed() || !payload) return;
    const width = clamp(Math.round(Number(payload.width) || DEFAULT_WIDTH), MIN_WIDTH, MAX_WIDTH);
    const height = clamp(Math.round(Number(payload.height) || DEFAULT_HEIGHT), MIN_HEIGHT, MAX_HEIGHT);
    const [currentWidth, currentHeight] = win.getContentSize();
    if (width === currentWidth && height === currentHeight) return;
    win.setContentSize(width, height);
    keepOnScreen();
  });

  ipcMain.on('widget:drag-start', () => {
    if (!win || win.isDestroyed() || config.get('clickThrough')) return;
    const cursor = screen.getCursorScreenPoint();
    const [x, y] = win.getPosition();
    dragOffset = { dx: cursor.x - x, dy: cursor.y - y };

    if (dragTimer) clearInterval(dragTimer);
    dragTimer = setInterval(() => {
      if (!win || win.isDestroyed() || !dragOffset) return;
      const point = screen.getCursorScreenPoint();
      win.setPosition(point.x - dragOffset.dx, point.y - dragOffset.dy, false);
    }, 16);

    if (dragSafetyTimer) clearTimeout(dragSafetyTimer);
    dragSafetyTimer = setTimeout(endDrag, 60000);
  });

  ipcMain.on('widget:drag-end', () => endDrag());
}

function endDrag() {
  if (dragTimer) {
    clearInterval(dragTimer);
    dragTimer = null;
  }
  if (dragSafetyTimer) {
    clearTimeout(dragSafetyTimer);
    dragSafetyTimer = null;
  }
  if (!dragOffset) return;
  dragOffset = null;
  persistPosition();
}

/* ------------------------------------------------------------------ *
 * 全局快捷键：Ctrl/Cmd + Alt + N 显示/隐藏
 * ------------------------------------------------------------------ */

function registerShortcuts() {
  try {
    globalShortcut.register('CommandOrControl+Alt+N', () => toggleWindow());
  } catch (err) {
    console.warn('[net-speed-widget] 注册全局快捷键失败:', err.message);
  }
}

/* ------------------------------------------------------------------ *
 * 生命周期
 * ------------------------------------------------------------------ */

function boot() {
  app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');
  app.setAppUserModelId('com.cline.netspeedwidget');

  // 诊断模式：只写环境信息然后退出，不建窗口、不测速
  if (process.argv.includes('--diagnose')) {
    app.whenReady().then(() => {
      const { file, info } = writeDiagnostics();
      console.log(`diagnostics written to ${file}`);
      console.log(JSON.stringify(info, null, 2));
      app.exit(0);
    });
    return;
  }

  app.whenReady().then(() => {
    config = createConfigStore(app.getPath('userData'));
    createWindow();
    createTray();
    registerIpc();
    registerShortcuts();
    startMonitoring();
    applyLaunchAtLogin(config.get('launchAtLogin'));
  });

  app.on('second-instance', () => showWindow());

  // 托盘常驻，关掉窗口不等于退出
  app.on('window-all-closed', () => {});

  app.on('will-quit', () => {
    globalShortcut.unregisterAll();
    if (monitor) monitor.stop();
    if (config) config.flush();
  });

  app.on('before-quit', () => {
    quitting = true;
    if (monitor) monitor.stop();
  });
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  boot();
}
