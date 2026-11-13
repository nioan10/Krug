const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('permission', {
  onDevices: callback => ipcRenderer.once('krug:permission-devices', (_event, devices) => callback(devices)),
  choose: allow => ipcRenderer.send('krug:permission-choice', allow === true)
});
