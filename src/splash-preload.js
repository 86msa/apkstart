'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('apkstartSplash', {
  version: () => ipcRenderer.invoke('splash:version'),
  isFirstRun: () => ipcRenderer.invoke('splash:isFirstRun'),
  onProgress: (cb) => { ipcRenderer.on('splash:progress', (_e, p) => cb(p)); },
  onDone: (cb) => { ipcRenderer.on('splash:done', () => cb()); },
  close: () => ipcRenderer.send('splash:close'),
});
