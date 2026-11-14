(() => {
  if (!navigator.serviceWorker || document.getElementById('krug-manual-update')) return;
  const bar = document.createElement('div');
  bar.id = 'krug-manual-update';
  bar.className = 'update-banner';
  Object.assign(bar.style, { position: 'fixed', bottom: '0', left: '0', right: '0', zIndex: '10000' });
  bar.setAttribute('role', 'status');
  const message = document.createElement('span');
  message.textContent = 'Доступна новая версия Округа.';
  const button = document.createElement('button');
  button.textContent = 'Обновить';
  bar.append(message, button);
  const mount = () => { if (!bar.isConnected) document.body.append(bar); };
  if (document.body) mount(); else document.addEventListener('DOMContentLoaded', mount, { once: true });
  let queued = false;
  const inCall = () => Boolean(document.querySelector('.voice-container, .preview-badge'));
  const apply = () => {
    if (!queued || inCall()) return;
    const worker = navigator.serviceWorker.controller;
    if (!worker) { message.textContent = 'Не удалось установить обновление. Попробуйте ещё раз.'; queued = false; return; }
    queued = false; button.disabled = true; message.textContent = 'Устанавливаем обновление…';
    const channel = new MessageChannel();
    const timer = setTimeout(() => { button.disabled = false; message.textContent = 'Не удалось установить обновление. Попробуйте ещё раз.'; }, 15000);
    channel.port1.onmessage = event => { if (event.data?.applied) { clearTimeout(timer); location.reload(); } };
    worker.postMessage({ type: 'APPLY_UPDATE' }, [channel.port2]);
  };
  button.addEventListener('click', () => {
    if (queued) { queued = false; button.textContent = 'Обновить'; message.textContent = 'Доступна новая версия Округа.'; return; }
    queued = true;
    if (inCall()) { button.textContent = 'Отменить'; message.textContent = 'Обновление установится после выхода из звонка.'; }
    apply();
  });
  new MutationObserver(apply).observe(document.documentElement, { childList: true, subtree: true });
})();
