import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { isIP } from 'node:net';
import { parseArgs, parseEnv } from 'node:util';

const { values } = parseArgs({ options: { domain: { type: 'string' }, 'media-domain': { type: 'string' }, 'turn-domain': { type: 'string' }, 'public-ip': { type: 'string' } } });
const domains = [values.domain, values['media-domain'], values['turn-domain']];
const pattern = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
if (!domains.every(v => typeof v === 'string' && pattern.test(v)) || new Set(domains).size !== 3 || isIP(values['public-ip'] || '') !== 4) throw new Error('Укажите --domain, --media-domain, --turn-domain и --public-ip IPv4.');
const envText = readFileSync('.env', 'utf8'), env = parseEnv(envText);
if (env.STREAM_ORIGIN || existsSync('deploy/stream-livekit.yaml')) throw new Error('Эфиры уже настроены. Ключи не перезаписаны.');
const caddyText = readFileSync('deploy/caddy.json', 'utf8'), caddy = JSON.parse(caddyText);
const main = caddy.apps?.http?.servers?.main;
const layer4 = main?.listener_wrappers?.find(v => v.wrapper === 'layer4');
if (!main?.routes || !layer4?.routes || !caddy.apps.tls?.certificates?.automate) throw new Error('Нужна конфигурация Caddy из scripts/setup.mjs.');
if (domains.some(d => caddy.apps.tls.certificates.automate.includes(d))) throw new Error('Для эфиров нужны отдельные домены.');
const key = 'API' + randomBytes(9).toString('hex'), secret = randomBytes(32).toString('base64url');
const yaml = `port: 7890
bind_addresses: ["127.0.0.1"]
rtc:
  tcp_port: 7891
  udp_port: 7892
  node_ip: ${values['public-ip']}
  use_external_ip: false
room:
  max_participants: 16
  empty_timeout: 120
  departure_timeout: 30
logging:
  level: warn
keys:
  ${key}: ${secret}
turn:
  enabled: true
  domain: ${values['turn-domain']}
  tls_port: 5350
  udp_port: 3479
  external_tls: true
  proxy_protocol: true
  proxy_protocol_trusted_cidrs: ["127.0.0.1/32"]
  relay_range_start: 30110
  relay_range_end: 30210
`;
caddy.apps.tls.certificates.automate.push(...domains);
main.routes.push(
  { match: [{ host: [values.domain] }], handle: [{ handler: 'reverse_proxy', upstreams: [{ dial: '127.0.0.1:3001' }] }] },
  { match: [{ host: [values['media-domain']] }], handle: [{ handler: 'reverse_proxy', upstreams: [{ dial: '127.0.0.1:7890' }] }] },
);
layer4.routes.push({ match: [{ tls: { sni: [values['turn-domain']] } }], handle: [{ handler: 'tls' }, { handler: 'proxy', proxy_protocol: 'v2', upstreams: [{ dial: ['127.0.0.1:5350'] }] }] });
mkdirSync('.setup', { recursive: true, mode: 0o700 });
const backup = '.setup/before-streams-' + Date.now();
mkdirSync(backup, { mode: 0o700 });
writeFileSync(backup + '/env', envText, { mode: 0o600, flag: 'wx' });
writeFileSync(backup + '/caddy.json', caddyText, { mode: 0o600, flag: 'wx' });
writeFileSync('deploy/stream-livekit.yaml', yaml, { mode: 0o600, flag: 'wx' });
const cleanEnv = envText.replace(/^STREAM_(?:ORIGIN|DATABASE_PATH|LIVEKIT_URL|LIVEKIT_API_KEY|LIVEKIT_API_SECRET)=.*\r?\n?/gm, '');
writeFileSync('.env', cleanEnv.trimEnd() + `\n\nSTREAM_ORIGIN=https://${values.domain}\nSTREAM_DATABASE_PATH=/app/streams/streams.sqlite\nSTREAM_LIVEKIT_URL=wss://${values['media-domain']}\nSTREAM_LIVEKIT_API_KEY=${key}\nSTREAM_LIVEKIT_API_SECRET=${secret}\n`, { mode: 0o600 });
// Preserve the inode: an existing container may bind-mount this exact file.
writeFileSync('deploy/caddy.json', JSON.stringify(caddy, null, 2) + '\n', { mode: 0o600 });
console.log('Настройки эфиров добавлены. Предыдущие .env и Caddy сохранены в ' + backup + '.');
console.log('Далее: DNS, firewall и docker compose --profile streams up -d --build (см. docs/STREAMING.md).');
