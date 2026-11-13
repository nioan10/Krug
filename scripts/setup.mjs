import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { isIP } from 'node:net';
import { parseArgs } from 'node:util';

const { values } = parseArgs({ options: {
  domain: { type: 'string' }, 'media-domain': { type: 'string' }, 'turn-domain': { type: 'string' },
  'public-ip': { type: 'string' },
} });
if (existsSync('.env')) { console.error('.env уже существует. Настройка остановлена, чтобы не перезаписать ключи. Для нового сервера используйте чистый клон.'); process.exit(1); }
const production = Boolean(values.domain);
const domainPattern = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
if (production) {
  if (![values.domain, values['media-domain'], values['turn-domain']].every(v => typeof v === 'string' && domainPattern.test(v))) throw new Error('Укажите три домена: --domain, --media-domain, --turn-domain (без https://).');
  if (new Set([values.domain, values['media-domain'], values['turn-domain']]).size !== 3) throw new Error('Нужны три разных доменных имени.');
  if (isIP(values['public-ip'] || '') !== 4) throw new Error('Укажите публичный IPv4 сервера: --public-ip 1.2.3.4');
} else if (Object.keys(values).length) throw new Error('Для серверной настройки укажите --domain.');
const secret = () => randomBytes(32).toString('base64url');
const key = `API${randomBytes(9).toString('hex')}`;
const apiSecret = secret(); const invite = secret();
const origin = production ? `https://${values.domain}` : 'http://localhost:5173';
mkdirSync('deploy', { recursive: true }); mkdirSync('.setup', { recursive: true, mode: 0o700 }); mkdirSync('data', { recursive: true, mode: 0o700 });
const save = (path, content) => writeFileSync(path, content, { mode: 0o600, flag: 'wx' });
save('deploy/livekit.yaml', `port: 7880
bind_addresses: ["127.0.0.1"]
rtc:
  tcp_port: 7881
  udp_port: 7882
  node_ip: ${production ? values['public-ip'] : '127.0.0.1'}
  use_external_ip: false
  enable_loopback_candidate: ${!production}
room:
  max_participants: 20
  empty_timeout: 300
  departure_timeout: 30
logging:
  level: warn
keys:
  ${key}: ${apiSecret}
${production ? `turn:
  enabled: true
  domain: ${values['turn-domain']}
  tls_port: 5349
  udp_port: 3478
  external_tls: true
  proxy_protocol: true
  proxy_protocol_trusted_cidrs: ["127.0.0.1/32"]
  relay_range_start: 30000
  relay_range_end: 30100
` : ''}`);
if (production) {
  const caddy = {
    admin: { disabled: true },
    storage: { module: 'file_system', root: '/data' },
    apps: {
      tls: { certificates: { automate: [values.domain, values['media-domain'], values['turn-domain']] } },
      http: { servers: {
        main: {
          listen: [':443'], protocols: ['h1', 'h2'],
          listener_wrappers: [
            { wrapper: 'layer4', routes: [{
              match: [{ tls: { sni: [values['turn-domain']] } }],
              handle: [{ handler: 'tls' }, { handler: 'proxy', proxy_protocol: 'v2', upstreams: [{ dial: ['127.0.0.1:5349'] }] }],
            }] },
            { wrapper: 'tls' },
          ],
          tls_connection_policies: [{}],
          routes: [
            { match: [{ host: [values.domain] }], handle: [{ handler: 'reverse_proxy', upstreams: [{ dial: '127.0.0.1:3000' }] }] },
            { match: [{ host: [values['media-domain']] }], handle: [{ handler: 'reverse_proxy', upstreams: [{ dial: '127.0.0.1:7880' }] }] },
          ],
        },
      } },
    },
  };
  save('deploy/caddy.json', JSON.stringify(caddy, null, 2) + '\n');
}
save('.env', `NODE_ENV=${production ? 'production' : 'development'}
HOST=127.0.0.1
PORT=3000
APP_ORIGIN=${origin}
DATABASE_PATH=data/krug.sqlite
LIVEKIT_URL=${production ? `wss://${values['media-domain']}` : 'ws://localhost:7880'}
LIVEKIT_API_KEY=${key}
LIVEKIT_API_SECRET=${apiSecret}
BOOTSTRAP_INVITE=${invite}
`);
save('.setup/first-invite.txt', `${origin}/#invite=${invite}\n`);
console.log('Готово. Созданы .env и конфигурация LiveKit.');
console.log('Приглашение владельца: .setup/first-invite.txt (одноразовое; действует 7 дней с первого запуска).');
console.log(production ? 'Далее: docker compose up -d --build' : 'Далее: pnpm install и pnpm dev. Для звонков запустите LiveKit (см. README).');
