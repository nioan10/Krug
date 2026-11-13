export type UpdateState = { available: boolean; queued: boolean; applying: boolean; error: string };
type Environment = {
  serviceWorker: ServiceWorkerContainer;
  page: Pick<Document, 'visibilityState' | 'addEventListener' | 'removeEventListener'>;
  events: EventTarget;
  online: () => boolean;
  reload: () => void;
};

/** Detect updates independently of navigation, and reload only after the user's request. */
export function createUpdateManager(environment: Environment) {
  const { serviceWorker, page, events } = environment;
  let state: UpdateState = { available: false, queued: false, applying: false, error: '' };
  const listeners = new Set<() => void>();
  const cleanup: (() => void)[] = [];
  const watched = new WeakSet<ServiceWorker>();
  let registration: ServiceWorkerRegistration | undefined;
  let waiting: ServiceWorker | null = null;
  let controller = serviceWorker.controller;
  let needsReload = false;
  let inCall = false;
  let requested = false;
  let reloaded = false;
  let stopped = false;
  let started = false;
  let lastCheck = -Infinity;
  let checking: Promise<void> | undefined;
  let activationTimeout: ReturnType<typeof setTimeout> | undefined;

  function publish(next: Partial<UpdateState>) {
    const updated = { ...state, ...next };
    if (JSON.stringify(updated) === JSON.stringify(state)) return;
    state = updated; listeners.forEach(listener => listener());
  }
  function syncWaiting() {
    waiting = registration?.waiting || (waiting?.state === 'installed' ? waiting : null);
    publish({ available: needsReload || Boolean(waiting) });
  }
  function reloadWhenSafe() {
    if (!requested || !needsReload || reloaded || inCall || stopped) return;
    reloaded = true; clearTimeout(activationTimeout); environment.reload();
  }
  function controllerChanged() {
    const next = serviceWorker.controller;
    // The first installation taking control is not an update to this page.
    if (controller && next && next !== controller) needsReload = true;
    controller = next;
    clearTimeout(activationTimeout);
    syncWaiting();
    publish({ applying: false });
    reloadWhenSafe();
  }
  function watch(worker: ServiceWorker | null) {
    if (!worker || watched.has(worker)) return;
    watched.add(worker);
    const changed = () => {
      if (worker.state === 'installed' && serviceWorker.controller) waiting = worker;
      syncWaiting();
    };
    worker.addEventListener('statechange', changed);
    cleanup.push(() => worker.removeEventListener('statechange', changed));
    changed();
  }
  function check(force = false): Promise<void> {
    if (stopped || !environment.online()) return Promise.resolve();
    if (checking) return checking;
    if (!force && Date.now() - lastCheck < 15_000) return Promise.resolve();
    lastCheck = Date.now();
    checking = (async () => {
      if (!registration) {
        const result = await serviceWorker.register('/sw.js', { updateViaCache: 'none' });
        if (stopped) return;
        registration = result;
        const found = () => watch(result.installing);
        result.addEventListener('updatefound', found);
        cleanup.push(() => result.removeEventListener('updatefound', found));
        // Installation may already be in progress when register() resolves.
        watch(result.installing); watch(result.waiting);
      } else {
        await registration.update();
      }
      if (!stopped) syncWaiting();
    })().catch(() => { /* Offline checks retry on focus, reconnection or the next interval. */ })
      .finally(() => { checking = undefined; });
    return checking;
  }
  async function apply() {
    if (stopped || reloaded || state.applying) return;
    requested = true;
    if (inCall) { publish({ queued: true, error: '' }); return; }
    publish({ queued: false, applying: true, error: '' });
    syncWaiting();
    if (needsReload) { reloadWhenSafe(); return; }
    if (!waiting) await check(true);
    if (stopped) return;
    if (inCall) { publish({ applying: false, queued: true }); return; }
    if (needsReload) { reloadWhenSafe(); return; }
    if (!waiting) {
      requested = false;
      publish({ applying: false, error: 'Обновление ещё не готово. Повторите попытку.' });
      return;
    }
    clearTimeout(activationTimeout);
    activationTimeout = setTimeout(() => {
      if (reloaded || stopped) return;
      requested = false;
      publish({ applying: false, error: 'Не удалось установить обновление. Попробуйте ещё раз.' });
    }, 15_000);
    try { waiting.postMessage({ type: 'APPLY_UPDATE' }); }
    catch {
      clearTimeout(activationTimeout); requested = false;
      publish({ applying: false, error: 'Не удалось установить обновление. Попробуйте ещё раз.' });
    }
  }
  return {
    getSnapshot: () => state,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    check,
    start() {
      if (started) return;
      started = true;
      const checkVisible = () => { if (page.visibilityState === 'visible') void check(); };
      const reconnected = () => { if (page.visibilityState === 'visible') void check(true); };
      serviceWorker.addEventListener('controllerchange', controllerChanged);
      page.addEventListener('visibilitychange', checkVisible);
      events.addEventListener('focus', checkVisible);
      events.addEventListener('online', reconnected);
      const timer = setInterval(checkVisible, 60_000);
      cleanup.push(() => { clearInterval(timer); serviceWorker.removeEventListener('controllerchange', controllerChanged); page.removeEventListener('visibilitychange', checkVisible); events.removeEventListener('focus', checkVisible); events.removeEventListener('online', reconnected); });
      void check();
    },
    setInCall(value: boolean) {
      inCall = value;
      if (inCall && state.applying) { clearTimeout(activationTimeout); publish({ applying: false, queued: true }); }
      if (!inCall && state.queued) void apply();
    },
    request(value: boolean) { inCall = value; return apply(); },
    cancel() { if (!state.applying) { requested = false; publish({ queued: false }); } },
    stop() { stopped = true; clearTimeout(activationTimeout); cleanup.forEach(dispose => dispose()); listeners.clear(); },
  };
}
