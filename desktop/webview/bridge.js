(() => {
  const pending = new Map();
  const audioListeners = new Set();
  const endedListeners = new Set();
  const updateListeners = new Set();
  let nextId = 0;
  function invoke(method, value) {
    return new Promise((resolve, reject) => {
      const id = ++nextId;
      pending.set(id, { resolve, reject });
      window.chrome.webview.postMessage({ id, method, value });
    });
  }
  function listen(set, callback) { set.add(callback); return () => set.delete(callback); }
  window.chrome.webview.addEventListener('message', event => {
    const message = event.data;
    if (!message || typeof message !== 'object') return;
    if (message.type === 'audio' && typeof message.data === 'string') {
      const decoded = atob(message.data), bytes = new Uint8Array(decoded.length);
      for (let i = 0; i < decoded.length; i++) bytes[i] = decoded.charCodeAt(i);
      audioListeners.forEach(fn => fn(bytes));
    } else if (message.type === 'audio-ended') endedListeners.forEach(fn => fn());
    else if (message.type === 'update') updateListeners.forEach(fn => fn(message.status));
    else if (message.type === 'result' && pending.has(message.id)) {
      const request = pending.get(message.id); pending.delete(message.id);
      if (message.error) request.reject(new Error(message.error)); else request.resolve(message.value);
    }
  });
  window.krugDesktop = Object.freeze({
    startAudio: () => invoke('audio-start'),
    stopAudio: () => invoke('audio-stop'),
    onAudio: callback => listen(audioListeners, callback),
    onAudioEnded: callback => listen(endedListeners, callback),
    setCallActive: active => invoke('call-state', active),
    getUpdateState: () => invoke('update-state'),
    onUpdate: callback => listen(updateListeners, callback),
  });
})();
