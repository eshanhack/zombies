import { randomBytes } from 'node:crypto';
import { connect as connectTcp, type Socket } from 'node:net';
import { connect as connectTls, type TLSSocket } from 'node:tls';
import { CONFIG } from '../src/config.js';

const socketEndpoint = process.env.GAME_SERVER_URL ?? CONFIG.coop.localServerUrl;
const httpEndpoint = socketEndpoint.replace(/^ws/u, 'http');
const allowedOrigin = process.env.CLIENT_TEST_ORIGIN ?? 'http://127.0.0.1:4173';
const untrustedOrigin = 'https://untrusted.example';

const health = await fetch(`${httpEndpoint}/health`, { headers: { Origin: allowedOrigin } });
if (!health.ok) throw new Error(`Health endpoint returned ${health.status}.`);
if (health.headers.get('access-control-allow-origin') !== allowedOrigin) throw new Error('Configured client origin was not allowed.');
const healthBody = await health.json() as { ok?: boolean; protocolVersion?: number; releaseVersion?: string };
if (healthBody.ok !== true || healthBody.protocolVersion !== CONFIG.coop.protocolVersion) throw new Error('Health protocol contract failed.');

const untrustedHealth = await fetch(`${httpEndpoint}/health`, { headers: { Origin: untrustedOrigin } });
if (untrustedHealth.headers.get('access-control-allow-origin') !== null) throw new Error('Untrusted health origin was reflected.');

const untrustedPreflight = await fetch(`${httpEndpoint}/matchmake/joinOrCreate/stahlbunker`, {
  method: 'OPTIONS',
  headers: { Origin: untrustedOrigin },
});
if (untrustedPreflight.headers.get('access-control-allow-origin') !== 'null') throw new Error('Untrusted matchmaking preflight was allowed.');

const untrustedWebSocketStatus = await websocketHandshakeStatus(socketEndpoint, untrustedOrigin);
if (untrustedWebSocketStatus === 101) throw new Error('Untrusted WebSocket origin completed an upgrade.');

console.log(JSON.stringify({
  ok: true,
  protocolVersion: healthBody.protocolVersion,
  releaseVersion: healthBody.releaseVersion,
  allowedOrigin,
  untrustedHealthAllowOrigin: null,
  untrustedPreflightAllowOrigin: 'null',
  untrustedWebSocketStatus,
}, null, 2));

function websocketHandshakeStatus(endpoint: string, origin: string): Promise<number> {
  const url = new URL(endpoint);
  const secure = url.protocol === 'wss:';
  const port = Number(url.port || (secure ? 443 : 80));
  return new Promise((resolve, reject) => {
    const socket: Socket | TLSSocket = secure
      ? connectTls({ host: url.hostname, port, servername: url.hostname })
      : connectTcp({ host: url.hostname, port });
    let response = '';
    const timeout = setTimeout(() => {
      socket.destroy();
      reject(new Error('WebSocket origin probe timed out.'));
    }, 4000);
    socket.once('connect', () => {
      const key = randomBytes(16).toString('base64');
      socket.write([
        `GET ${url.pathname || '/'} HTTP/1.1`,
        `Host: ${url.host}`,
        'Upgrade: websocket',
        'Connection: Upgrade',
        `Sec-WebSocket-Key: ${key}`,
        'Sec-WebSocket-Version: 13',
        `Origin: ${origin}`,
        '',
        '',
      ].join('\r\n'));
    });
    socket.on('data', (chunk) => {
      response += chunk.toString('utf8');
      if (!response.includes('\r\n\r\n')) return;
      clearTimeout(timeout);
      socket.destroy();
      const status = Number(response.match(/^HTTP\/1\.1 (\d{3})/u)?.[1]);
      if (!Number.isFinite(status)) reject(new Error('WebSocket origin probe returned an invalid response.'));
      else resolve(status);
    });
    socket.once('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
  });
}
