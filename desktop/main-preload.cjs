const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('desktopCapture', {
  getState: () => ipcRenderer.invoke('desktop-state'),
  start: () => ipcRenderer.invoke('desktop-capture'),
  setHotkey: value => ipcRenderer.invoke('desktop-hotkey', value),
  chooseDirectory: () => ipcRenderer.invoke('desktop-directory'),
  onState: callback => { const listener = (_event, state) => callback(state); ipcRenderer.on('desktop-state', listener); return () => ipcRenderer.removeListener('desktop-state', listener); },
});
