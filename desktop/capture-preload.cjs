const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('captureOverlay', {
  onFrame: callback => { ipcRenderer.on('capture-frame', (_event, frame) => callback(frame)); },
  ready: () => ipcRenderer.send('capture-ready'),
  select: rect => ipcRenderer.send('capture-select', rect),
  cancel: () => ipcRenderer.send('capture-cancel'),
});
