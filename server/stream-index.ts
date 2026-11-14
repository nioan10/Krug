import { buildStreamApp } from './stream-app.ts';
import { readStreamConfig } from './stream-config.ts';
const app = await buildStreamApp(readStreamConfig());
await app.listen({ host: '127.0.0.1', port: Number(process.env.STREAM_PORT || 3001) });
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, async () => { await app.close(); process.exit(0); });
