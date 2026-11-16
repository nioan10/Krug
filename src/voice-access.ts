import { HttpError, isTransientRequestError } from './api';

export type VoiceAccess = { enabled: boolean; roster: string };

/** Keep the encrypted call during short API outages; never ignore an explicit denial or key change. */
export class VoiceAccessMonitor {
  private stopped = false;
  private checking = false;
  private again = false;
  private timer?: ReturnType<typeof setTimeout>;
  private grace?: ReturnType<typeof setTimeout>;
  private controller?: AbortController;
  private expected: { enabled: boolean; roster?: string };
  private rotationPending = false;
  constructor(private readonly options: {
    expected: { enabled: boolean; roster?: string };
    request: (signal: AbortSignal) => Promise<VoiceAccess>;
    waiting: (value: boolean) => void;
    denied: (message: string) => void;
    rotate?: (state: VoiceAccess, signal: AbortSignal) => Promise<VoiceAccess>;
  }) { this.expected = { ...options.expected }; }
  check = () => {
    if (this.stopped) return;
    clearTimeout(this.timer);
    if (this.checking) { this.again = true; return; }
    void this.run();
  };
  stop() {
    this.stopped = true;
    clearTimeout(this.timer); clearTimeout(this.grace);
    this.controller?.abort();
  }
  private deny(message: string) {
    if (this.stopped) return;
    this.stop(); this.options.denied(message);
  }
  private async run() {
    this.checking = true;
    const controller = new AbortController(); this.controller = controller;
    let deadline = setTimeout(() => controller.abort(new DOMException('Access check timed out', 'TimeoutError')), 8000);
    let abort: () => void = () => {};
    const cancelled = new Promise<never>((_resolve, reject) => {
      abort = () => reject(controller.signal.reason);
      controller.signal.addEventListener('abort', abort, { once: true });
    });
    let nextCheck = 10_000;
    try {
      const state = await Promise.race([this.options.request(controller.signal), cancelled]);
      if (this.stopped) return;
      if (typeof state.enabled !== 'boolean' || typeof state.roster !== 'string') throw Error('Некорректный ответ проверки доступа.');
      if (state.enabled !== this.expected.enabled) {
        this.deny('Состав ключей изменился. Подключитесь к комнате заново для обновления шифрования.'); return;
      }
      if (state.enabled && (state.roster !== this.expected.roster || this.rotationPending)) {
        if (!this.options.rotate) { this.deny('Состав ключей изменился. Подключитесь к комнате заново для обновления шифрования.'); return; }
        this.options.waiting(true);
        this.rotationPending = true;
        clearTimeout(deadline);
        deadline = setTimeout(() => controller.abort(new DOMException('Key rotation timed out', 'TimeoutError')), 20_000);
        const current = await Promise.race([this.options.rotate(state, controller.signal), cancelled]);
        if (this.stopped) return;
        if (!current.enabled || !current.roster) throw Error('Не удалось подтвердить новый ключ звонка.');
        this.expected = current; this.rotationPending = false; nextCheck = 1000;
      }
      clearTimeout(this.grace); this.grace = undefined;
      this.options.waiting(false);
    } catch (error) {
      if (this.stopped) return;
      if (isTransientRequestError(error) || (this.options.rotate && error instanceof HttpError && error.status === 409)) {
        this.options.waiting(true); nextCheck = error instanceof HttpError ? Math.max(3000, error.retryAfterMs) : 3000;
        const graceMs = error instanceof HttpError && error.status === 429 ? Math.max(30_000, Math.min(90_000, nextCheck + 10_000)) : 30_000;
        this.grace ??= setTimeout(() => this.deny(`Сервер не подтверждает доступ больше ${graceMs / 1000} секунд. Звонок остановлен; подключитесь снова, когда связь восстановится.`), graceMs);
      } else if (error instanceof HttpError && [401, 403].includes(error.status)) {
        this.deny('Доступ к звонку отозван или сессия завершилась. Войдите снова.');
      } else if (error instanceof HttpError && error.status === 404) {
        this.deny('Голосовая комната больше недоступна.');
      } else {
        this.deny(error instanceof Error ? `Проверка доступа отклонена: ${error.message}` : 'Не удалось проверить безопасность звонка.');
      }
    } finally {
      clearTimeout(deadline); controller.signal.removeEventListener('abort', abort);
      this.checking = false; this.controller = undefined;
      if (!this.stopped) { this.timer = setTimeout(this.check, this.again ? 0 : nextCheck); this.again = false; }
    }
  }
}
