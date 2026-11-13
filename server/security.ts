import { randomBytes, scrypt as scryptCallback, createHash, timingSafeEqual } from 'node:crypto';
const options = { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
let active = 0;
export class ApiError extends Error {
  constructor(public statusCode: number, message: string) { super(message); }
}
export const newSecret = () => randomBytes(32).toString('base64url');
export const digest = (value: string) => createHash('sha256').update(value).digest('hex');
async function derive(password: string, salt: string) {
  if (active >= 4) throw new ApiError(429, 'Слишком много попыток. Попробуйте чуть позже.');
  active++;
  try { return await new Promise<Buffer>((resolve, reject) => scryptCallback(password, salt, 64, options, (error, key) => error ? reject(error) : resolve(key))); }
  finally { active--; }
}
export async function hashPassword(password: string) {
  const salt = newSecret();
  return `scrypt:${salt}:${(await derive(password, salt)).toString('hex')}`;
}
export async function verifyPassword(password: string, encoded: string) {
  const [, salt, hash] = encoded.split(':');
  const actual = await derive(password, salt);
  const expected = Buffer.from(hash, 'hex');
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}
