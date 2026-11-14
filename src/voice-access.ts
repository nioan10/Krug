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
  constructor(private readonly options: {
    expected: { enabled: boolean; roster?: string };
    request: (signal: AbortSignal) => Promise<VoiceAccess>;
    waiting: (value: boolean) => void;
    denied: (message: string) => void;
  }) {}
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
    const deadline = setTimeout(() => controller.abort(new DOMException('Access check timed out', 'TimeoutError')), 8000);
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
      if (state.enabled !== this.options.expected.enabled || (state.enabled && state.roster !== this.options.expected.roster)) {
        this.deny('Состав ключей изменился. Подключитесь к комнате заново для обновления шифрования.'); return;
      }
      clearTimeout(this.grace); this.grace = undefined;
      this.options.waiting(false);
    } catch (error) {
      if (this.stopped) return;
      if (isTransientRequestError(error)) {
        this.options.waiting(true); nextCheck = 3000;
        this.grace ??= setTimeout(() => this.deny('Сервер не подтверждает доступ больше 30 секунд. Звонок остановлен; подключитесь снова, когда связь восстановится.'), 30_000);
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
