import { z } from 'zod';

export type Config = ReturnType<typeof readConfig>;
export function readConfig(env: NodeJS.ProcessEnv = process.env) {
  const raw = z.object({
    NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
    HOST: z.string().default('127.0.0.1'),
    PORT: z.coerce.number().int().min(1).max(65535).default(3000),
    APP_ORIGIN: z.url().default('http://localhost:5173'),
    DATABASE_PATH: z.string().default('data/krug.sqlite'),
    DESKTOP_UPDATE_DIR: z.string().default('desktop-updates'),
    LIVEKIT_URL: z.url().default('ws://localhost:7880'),
    LIVEKIT_API_KEY: z.string().min(8),
    LIVEKIT_API_SECRET: z.string().min(32),
    BOOTSTRAP_INVITE: z.string().min(32),
  }).parse(env);
  const origin = new URL(raw.APP_ORIGIN);
  if (raw.APP_ORIGIN !== origin.origin) throw new Error('APP_ORIGIN must be an origin without a path or trailing slash');
  if (!['ws:', 'wss:'].includes(new URL(raw.LIVEKIT_URL).protocol)) throw new Error('LIVEKIT_URL must use ws:// or wss://');
  if (raw.NODE_ENV === 'production' && (origin.protocol !== 'https:' || !raw.LIVEKIT_URL.startsWith('wss://'))) {
    throw new Error('Production requires HTTPS and WSS');
  }
  return raw;
}
