'use strict';

const { contextBridge, ipcRenderer } = require('electron');

/**
 * 只暴露渲染器真正需要的能力，保持 contextIsolation + sandbox 开启。
 */
contextBridge.exposeInMainWorld('netSpeed', {
  onSample(callback) {
    const listener = (event, payload) => callback(payload);
    ipcRenderer.on('speed:sample', listener);
    return () => ipcRenderer.removeListener('speed:sample', listener);
  },
  onState(callback) {
    const listener = (event, payload) => callback(payload);
    ipcRenderer.on('speed:state', listener);
    return () => ipcRenderer.removeListener('speed:state', listener);
  },
  reportSize(width, height) {
    ipcRenderer.send('widget:size', { width, height });
  },
  openMenu() {
    ipcRenderer.send('widget:menu');
  },
  startDrag() {
    ipcRenderer.send('widget:drag-start');
  },
  endDrag() {
    ipcRenderer.send('widget:drag-end');
  }
});
