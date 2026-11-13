import { useState, useSyncExternalStore } from 'react';
import { Check, Download, RefreshCw } from 'lucide-react';
import { Modal } from './ui';

interface InstallPrompt extends Event { prompt(): Promise<{ outcome: 'accepted' | 'dismissed' }> }
let prompt: InstallPrompt | null = null;
let registration: ServiceWorkerRegistration | null = null;
let snapshot = { installed: window.matchMedia('(display-mode: standalone)').matches || Boolean((navigator as Navigator & { standalone?: boolean }).standalone), ready: false, update: false };
const listeners = new Set<() => void>();
function update(next: Partial<typeof snapshot>) { snapshot = { ...snapshot, ...next }; listeners.forEach(fn => fn()); }
function subscribe(fn: () => void) { listeners.add(fn); return () => { listeners.delete(fn); }; }
window.addEventListener('beforeinstallprompt', event => { event.preventDefault(); prompt = event as InstallPrompt; update({ ready: true }); });
window.addEventListener('appinstalled', () => { prompt = null; update({ installed: true, ready: false }); });
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').then(result => {
    registration = result;
    if (result.waiting) update({ update: true });
    result.addEventListener('updatefound', () => {
      const worker = result.installing;
      worker?.addEventListener('statechange', () => { if (worker.state === 'installed' && navigator.serviceWorker.controller) update({ update: true }); });
    });
  }).catch(() => { /* Installation remains available without offline caching. */ });
}
export function InstallApp({ compact = false }: { compact?: boolean }) {
  const state = useSyncExternalStore(subscribe, () => snapshot);
  const [help, setHelp] = useState(false);
  async function install() {
    if (!prompt) { setHelp(true); return; }
    const event = prompt; prompt = null;
    try { const result = await event.prompt(); if (result.outcome === 'accepted') update({ installed: true }); }
    catch { setHelp(true); }
    finally { update({ ready: false }); }
  }
  return <>
    {!state.installed && <button className={compact ? 'install-sidebar' : 'install-auth'} onClick={() => void install()}><Download size={16} />Установить приложение</button>}
    {help && <Modal title="Установить Круг" onClose={() => setHelp(false)}><div className="install-help"><p>Приложение открывается в отдельном окне. Для звонков и переписки нужен интернет.</p>
      <h3>Windows, Linux, Android</h3><p>Откройте этот адрес в Chrome или Edge. Нажмите значок установки в адресной строке или выберите «Установить приложение» в меню браузера.</p>
      <h3>iPhone и iPad</h3><p>Откройте адрес в Safari → «Поделиться» → «На экран Домой».</p>
      <h3>Mac</h3><p>В Safari: «Файл» → «Добавить в Dock». Также можно установить через Chrome.</p>
      <p className="muted">Если вы открыли Круг внутри другого приложения, скопируйте адрес в обычный браузер. Установка доступна по HTTPS или на localhost.</p>
    </div></Modal>}
  </>;
}
export function AppUpdate({ inCall }: { inCall: boolean }) {
  const state = useSyncExternalStore(subscribe, () => snapshot);
  if (!state.update) return null;
  function apply() {
    navigator.serviceWorker.addEventListener('controllerchange', () => location.reload(), { once: true });
    registration?.waiting?.postMessage({ type: 'APPLY_UPDATE' });
  }
  return <div className="update-banner"><Check size={15} /><span>{inCall ? 'Обновление готово. Установите его после звонка.' : 'Доступна новая версия Круга.'}</span><button disabled={inCall} onClick={apply}><RefreshCw size={13} />Обновить</button></div>;
}
