import { ApiError } from './security.ts';

export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
export function decodeImage(base64: string): { mime: string; data: Buffer } {
  if (base64.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(base64)) throw new ApiError(400, 'Не удалось прочитать изображение.');
  const data = Buffer.from(base64, 'base64');
  if (!data.length || data.length > MAX_IMAGE_BYTES) throw new ApiError(400, 'Размер изображения не должен превышать 5 МБ.');
  const hex = data.subarray(0, 12).toString('hex');
  const mime = hex.startsWith('89504e470d0a1a0a') ? 'image/png' : hex.startsWith('ffd8ff') ? 'image/jpeg' : hex.startsWith('474946383761') || hex.startsWith('474946383961') ? 'image/gif' : hex.startsWith('52494646') && hex.slice(16, 24) === '57454250' ? 'image/webp' : null;
  if (!mime) throw new ApiError(400, 'Поддерживаются PNG, JPEG, GIF и WebP.');
  return { mime, data };
}
