import { buildApp } from './app.ts';
import { readConfig } from './config.ts';

const config = readConfig();
const app = await buildApp(config);
await app.listen({ host: config.HOST, port: config.PORT });
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, async () => { await app.close(); process.exit(0); });
}
