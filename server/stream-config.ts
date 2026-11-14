import { z } from 'zod';

export const streamFields = {
  STREAM_ORIGIN: z.string().default(''),
  STREAM_DATABASE_PATH: z.string().default('data/streams.sqlite'),
  STREAM_LIVEKIT_URL: z.string().default(''),
  STREAM_LIVEKIT_API_KEY: z.string().default(''),
  STREAM_LIVEKIT_API_SECRET: z.string().default(''),
};
export type StreamConfig = z.infer<ReturnType<typeof schema>>;
const schema = () => z.object({ ...streamFields, NODE_ENV: z.enum(['development', 'production', 'test']).default('development'), APP_ORIGIN: z.string() });
export function validateStreams(config: StreamConfig, required = false) {
  if (!config.STREAM_ORIGIN && !required) return;
  const origin = new URL(config.STREAM_ORIGIN);
  const appOrigin = new URL(config.APP_ORIGIN);
  const media = new URL(config.STREAM_LIVEKIT_URL);
  if (origin.origin !== config.STREAM_ORIGIN || appOrigin.origin !== config.APP_ORIGIN || origin.origin === appOrigin.origin || !['ws:', 'wss:'].includes(media.protocol)) throw new Error('Streams require separate, valid public and private origins');
  if (config.STREAM_LIVEKIT_API_KEY.length < 8 || config.STREAM_LIVEKIT_API_SECRET.length < 32) throw new Error('Streams require dedicated LiveKit credentials');
  if (config.NODE_ENV === 'production' && (origin.protocol !== 'https:' || appOrigin.protocol !== 'https:' || media.protocol !== 'wss:')) throw new Error('Public streams require HTTPS/WSS');
}
export function readStreamConfig(env: NodeJS.ProcessEnv = process.env) {
  const config = schema().parse(env); validateStreams(config, true); return config;
}
