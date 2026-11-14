(() => {
  const pending = new Map();
  const audioListeners = new Set();
  const endedListeners = new Set();
  const updateListeners = new Set();
  const timeoutMs = 15000;
  const maxAudioBase64Length = 128 * 1024;
  let nextId = 0;
  function invoke(method, value, deadline = timeoutMs) {
    return new Promise((resolve, reject) => {
      const id = ++nextId;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error('Desktop host did not respond'));
      }, deadline);
      pending.set(id, { resolve, reject, timer });
      try { window.chrome.webview.postMessage({ id, method, value }); }
      catch (error) { clearTimeout(timer); pending.delete(id); reject(error); }
    });
  }
  function listen(set, callback) { set.add(callback); return () => set.delete(callback); }
  window.chrome.webview.addEventListener('message', event => {
    const message = event.data;
    if (!message || typeof message !== 'object') return;
    if (message.type === 'audio' && typeof message.data === 'string' && message.data.length <= maxAudioBase64Length) {
      let decoded;
      try { decoded = atob(message.data); } catch { return; }
      const bytes = new Uint8Array(decoded.length);
      for (let i = 0; i < decoded.length; i++) bytes[i] = decoded.charCodeAt(i);
      audioListeners.forEach(fn => fn(bytes));
    } else if (message.type === 'audio-ended') endedListeners.forEach(fn => fn());
    else if (message.type === 'update') updateListeners.forEach(fn => fn(message.status));
    else if (message.type === 'result' && pending.has(message.id)) {
      const request = pending.get(message.id); pending.delete(message.id); clearTimeout(request.timer);
      if (message.error) request.reject(new Error(message.error)); else request.resolve(message.value);
    }
  });
  window.krugDesktop = Object.freeze({
    // The native application picker can legitimately stay open for a while.
    startAudio: () => invoke('audio-start', undefined, 120000),
    stopAudio: () => invoke('audio-stop'),
    onAudio: callback => listen(audioListeners, callback),
    onAudioEnded: callback => listen(endedListeners, callback),
    setCallActive: active => invoke('call-state', active),
    getUpdateState: () => invoke('update-state'),
    requestUpdate: () => invoke('update-request'),
    cancelUpdate: () => invoke('update-cancel'),
    onUpdate: callback => listen(updateListeners, callback),
  });
})();
