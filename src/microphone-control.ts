import type { Room } from 'livekit-client';

export type MicrophoneStage = 'capture' | 'processor' | 'publish' | 'unmute' | 'mute';

function errorName(error: unknown): string {
  return error && typeof error === 'object' && 'name' in error ? String(error.name) : '';
}

/** Only a missing selected input can fall back. Never retry a denied permission or busy device. */
export async function withMicrophoneRecovery<T>(
  room: Pick<Room, 'options' | 'getActiveDevice' | 'switchActiveDevice'>,
  operation: () => Promise<T>,
  active: () => boolean,
  recovered: () => void,
): Promise<T> {
  const check = () => { if (!active()) throw new DOMException('Call ended', 'AbortError'); };
  check();
  try { return await operation(); }
  catch (error) {
    const name = errorName(error);
    const selected = room.options.audioCaptureDefaults?.deviceId;
    const id = typeof selected === 'string' || Array.isArray(selected) ? selected : selected?.exact ?? selected?.ideal ?? room.getActiveDevice('audioinput');
    const explicitInput = Array.isArray(id) ? id.length > 0 && !id.includes('default') : id && id !== 'default';
    const missingSelection = explicitInput && (name === 'NotFoundError' || name === 'DevicesNotFoundError');
    const invalidDevice = name === 'OverconstrainedError' && typeof error === 'object' && error !== null && 'constraint' in error && error.constraint === 'deviceId';
    if (!missingSelection && !invalidDevice) throw error;
    check();
    await room.switchActiveDevice('audioinput', 'default', false);
    check();
    const result = await operation();
    if (active()) recovered();
    return result;
  }
}

export function microphoneErrorMessage(error: unknown, stage: MicrophoneStage): string {
  // A processor/network/playback error is not evidence that the user denied microphone access.
  if (stage === 'processor') return 'Не удалось запустить обработку микрофона. Обновите Круг и попробуйте ещё раз.';
  if (stage === 'publish') return 'Микрофон доступен, но звук не удалось подключить к звонку. Попробуйте ещё раз после восстановления связи.';
  if (stage === 'mute') return 'Не удалось выключить микрофон. Попробуйте ещё раз или выйдите из звонка.';
  switch (errorName(error)) {
    case 'NotAllowedError': case 'PermissionDeniedError': case 'SecurityError':
      return 'Доступ к микрофону запрещён. Разрешите его для Круга в браузере или приложении и проверьте доступ к микрофону в настройках конфиденциальности Windows.';
    case 'NotFoundError': case 'DevicesNotFoundError':
      return 'Микрофон не найден. Подключите его и выберите «По умолчанию» в настройках звука Круга.';
    case 'NotReadableError': case 'TrackStartError':
      return 'Не удалось открыть микрофон. Он может быть занят другой программой или недоступен системе. Закройте программу, использующую его, и попробуйте снова.';
    case 'OverconstrainedError':
      return 'Выбранный микрофон или его параметры недоступны. Выберите «По умолчанию» в настройках звука Круга.';
    case 'AbortError':
      return 'Включение микрофона прервалось. Попробуйте ещё раз.';
    default:
      return 'Не удалось включить микрофон. Переподключитесь к звонку и попробуйте ещё раз.';
  }
}
