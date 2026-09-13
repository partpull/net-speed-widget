'use strict';

const { contextBridge, ipcRenderer } = require('electron');

/**
 * 只暴露渲染器真正需要的能力，保持 contextIsolation + sandbox 开启。
 * 两个界面（悬浮钟 / 设置）共用这一个 preload。
 */
contextBridge.exposeInMainWorld('bidClock', {
  /** 主进程每秒推一次：{ text, phase, remainingMs, bidTime } */
  onTick(callback) {
    const listener = (event, payload) => callback(payload);
    ipcRenderer.on('clock:tick', listener);
    return () => ipcRenderer.removeListener('clock:tick', listener);
  },
  /** 设置界面打开时主进程推一次当前状态 */
  onSetupState(callback) {
    const listener = (event, payload) => callback(payload);
    ipcRenderer.on('setup:state', listener);
    return () => ipcRenderer.removeListener('setup:state', listener);
  },
  /** 悬浮钟量出自己的宽高比后回报主进程（决定窗口形状） */
  reportGeometry(geometry) {
    ipcRenderer.send('clock:ready', {
      aspect: geometry && geometry.aspect,
      fontVh: geometry && geometry.fontVh
    });
  },
  chooseBidTime(bidTime) {
    ipcRenderer.send('setup:choose', bidTime);
  },
  closeSetup() {
    ipcRenderer.send('setup:close');
  },
  openMenu() {
    ipcRenderer.send('clock:menu');
  },
  startDrag() {
    ipcRenderer.send('win:drag-start');
  },
  endDrag() {
    ipcRenderer.send('win:drag-end');
  },
  startResize() {
    ipcRenderer.send('clock:resize-start');
  },
  endResize() {
    ipcRenderer.send('clock:resize-end');
  }
});
