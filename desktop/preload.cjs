const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('krugDesktop', {
  startAudio: () => ipcRenderer.invoke('krug:audio-start'),
  stopAudio: () => ipcRenderer.invoke('krug:audio-stop'),
  onAudio: callback => { const listener = (_event, bytes) => callback(bytes); ipcRenderer.on('krug:audio-data', listener); return () => ipcRenderer.removeListener('krug:audio-data', listener); },
  onAudioEnded: callback => { const listener = () => callback(); ipcRenderer.on('krug:audio-ended', listener); return () => ipcRenderer.removeListener('krug:audio-ended', listener); }
});
