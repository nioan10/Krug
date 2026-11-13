const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('picker', {
  onSources: callback => ipcRenderer.once('krug:picker-sources', (_event, sources) => callback(sources)),
  choose: (id, audio) => ipcRenderer.send('krug:picker-choice', { id, audio }),
  cancel: () => ipcRenderer.send('krug:picker-choice', null)
});
