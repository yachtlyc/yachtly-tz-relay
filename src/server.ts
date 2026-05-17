/**
 * Yachtly TZ Relay — multi-source vessel-data bridge.
 *
 * SECURITY MODEL (spec §5):
 *   - Read-only on the boat's bus. The helper never writes to any gateway.
 *   - Local-network-only. HTTP + WebSocket clients from non-RFC-1918 IPs
 *     are refused with 403. The same gate covers the `/helper/*` control
 *     endpoints — only LAN callers can attach/detach sources.
 *   - Optional shared-secret token (`YACHTLY_RELAY_TOKEN`). When set, WS
 *     clients must pass `?token=...` in the URL; control endpoints require
 *     the same token in the `Authorization: Bearer <token>` header.
 *   - `maxPayload: 1024` — clients can't send anything large.
 *   - Malformed input from upstream gateways is dropped silently.
 *
 * Adapters live in src/adapters/ and are owned by the orchestrator. server.ts
 * here only manages the HTTP + WS surface and provides the `broadcast()`
 * callback the orchestrator funnels values through.
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { Socket } from 'node:net';
import { WebSocketServer, WebSocket } from 'ws';
import { CONFIG } from './config.js';
import { isLocalIP } from './localIp.js';
import { SUPPORTED_SENTENCES, type SignalKValue } from './nmeaToSignalK.js';
import type { SignalKPath } from './paths.js';
import { Orchestrator } from './orchestrator.js';

const RELAY_NAME = 'yachtly-tz-relay';
const RELAY_VERSION = '0.3.0';
const POST_RATE_WINDOW_MS = 60_000;
const POST_RATE_LIMIT = 10;

interface ClientFilter {
  paths: Set<SignalKPath> | 'all';
}

function applyCorsHeaders(res: ServerResponse): void {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
}

function buildDiscoveryPayload(hostHeader: string | undefined): Record<string, unknown> {
  const host = hostHeader ?? `localhost:${CONFIG.wsPort}`;
  return {
    endpoints: {
      v1: {
        version: '1.0.0',
        'signalk-http': `http://${host}/signalk/v1/api/`,
        'signalk-ws': `ws://${host}/signalk/v1/stream`,
      },
    },
    server: {
      id: RELAY_NAME,
      version: RELAY_VERSION,
    },
  };
}

const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 });
const clientFilters = new WeakMap<WebSocket, ClientFilter>();

function safeSend(ws: WebSocket, obj: unknown): void {
  if (ws.readyState !== WebSocket.OPEN) return;
  try {
    ws.send(JSON.stringify(obj));
  } catch (err) {
    log(`send failed: ${(err as Error).message}`);
  }
}

function safeSendRaw(ws: WebSocket, json: string): void {
  if (ws.readyState !== WebSocket.OPEN) return;
  try {
    ws.send(json);
  } catch (err) {
    log(`send failed: ${(err as Error).message}`);
  }
}

function broadcast(values: SignalKValue[]): void {
  if (values.length === 0) return;
  const timestamp = new Date().toISOString();
  const fullJson = JSON.stringify({
    context: 'vessels.self',
    updates: [
      {
        source: { label: RELAY_NAME, type: 'NMEA0183' },
        timestamp,
        values,
      },
    ],
  });

  for (const client of wss.clients) {
    if (client.readyState !== WebSocket.OPEN) continue;
    const filter = clientFilters.get(client);
    if (!filter || filter.paths === 'all') {
      safeSendRaw(client, fullJson);
      continue;
    }
    const filteredValues = values.filter((v) => (filter.paths as Set<SignalKPath>).has(v.path));
    if (filteredValues.length === 0) continue;
    safeSendRaw(
      client,
      JSON.stringify({
        context: 'vessels.self',
        updates: [
          {
            source: { label: RELAY_NAME, type: 'NMEA0183' },
            timestamp,
            values: filteredValues,
          },
        ],
      }),
    );
  }
}

// ── Helper control: rate limiter for POST /helper/sources ────────────────
const postHits = new Map<string, number[]>();
function rateLimited(ip: string): boolean {
  const now = Date.now();
  const hits = (postHits.get(ip) ?? []).filter((t) => now - t < POST_RATE_WINDOW_MS);
  if (hits.length >= POST_RATE_LIMIT) {
    postHits.set(ip, hits);
    return true;
  }
  hits.push(now);
  postHits.set(ip, hits);
  return false;
}

function checkBearerToken(req: IncomingMessage): boolean {
  if (!CONFIG.authToken) return true;
  const auth = req.headers['authorization'];
  if (!auth || typeof auth !== 'string') return false;
  const m = auth.match(/^Bearer\s+(.+)$/i);
  return m !== null && m[1] === CONFIG.authToken;
}

async function readJsonBody(req: IncomingMessage, max = 1024): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let buf = '';
    req.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      if (buf.length > max) {
        reject(new Error('payload too large'));
        req.destroy();
      }
    });
    req.on('end', () => {
      if (!buf) return resolve({});
      try {
        resolve(JSON.parse(buf));
      } catch {
        reject(new Error('invalid json'));
      }
    });
    req.on('error', reject);
  });
}

// ── HTTP server ──────────────────────────────────────────────────────────
const orchestrator = new Orchestrator({
  udpBindAddress: CONFIG.bindAddress,
  udpPort: CONFIG.udpPort,
  enable: {
    'udp-timezero': CONFIG.enable.udpTimeZero,
    'tcp-nmea0183': CONFIG.enable.tcpNmea0183,
    'tcp-n2k-yd-raw': CONFIG.enable.tcpN2KYDRaw,
    'tcp-n2k-actisense': CONFIG.enable.tcpN2KActisense,
  },
});

const httpServer = createServer(async (req: IncomingMessage, res: ServerResponse) => {
  const ip = req.socket.remoteAddress ?? '';
  if (!isLocalIP(ip)) {
    res.writeHead(403, { 'Content-Type': 'text/plain' });
    res.end('Forbidden');
    return;
  }

  applyCorsHeaders(res);

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  // Signal-K-compatible discovery — unchanged shape, so v0.2.0 dashboards keep working.
  if (req.method === 'GET' && (req.url === '/signalk' || req.url === '/signalk/')) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(buildDiscoveryPayload(req.headers.host)));
    return;
  }

  // ── Helper control surface — used by the dashboard banner to know what's
  // connected and hand off newly-discovered gateways. New in v0.3.0; old
  // clients ignore it.
  if (req.method === 'GET' && req.url === '/helper/status') {
    if (!checkBearerToken(req)) {
      res.writeHead(401, { 'Content-Type': 'text/plain' });
      res.end('Unauthorized');
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        server: { id: RELAY_NAME, version: RELAY_VERSION },
        ...orchestrator.statusSnapshot(),
      }),
    );
    return;
  }

  if (req.method === 'POST' && req.url === '/helper/sources') {
    if (!checkBearerToken(req)) {
      res.writeHead(401, { 'Content-Type': 'text/plain' });
      res.end('Unauthorized');
      return;
    }
    if (rateLimited(ip)) {
      res.writeHead(429, { 'Content-Type': 'text/plain' });
      res.end('Too many requests');
      return;
    }
    let body: unknown;
    try {
      body = await readJsonBody(req);
    } catch (err) {
      res.writeHead(400, { 'Content-Type': 'text/plain' });
      res.end((err as Error).message);
      return;
    }
    const b = body as { host?: string; port?: number; type?: string };
    if (!b.host || typeof b.host !== 'string' || !b.port || typeof b.port !== 'number') {
      res.writeHead(400, { 'Content-Type': 'text/plain' });
      res.end('host and port required');
      return;
    }
    const result = await orchestrator.tryAttach(
      b.host,
      b.port,
      b.type as undefined,
      CONFIG.probeTimeoutMs,
    );
    res.writeHead(result.ok ? 200 : 422, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(result));
    return;
  }

  if (req.method === 'DELETE' && req.url?.startsWith('/helper/sources/')) {
    if (!checkBearerToken(req)) {
      res.writeHead(401, { 'Content-Type': 'text/plain' });
      res.end('Unauthorized');
      return;
    }
    const id = decodeURIComponent(req.url.slice('/helper/sources/'.length));
    const ok = await orchestrator.detach(id);
    res.writeHead(ok ? 200 : 404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok }));
    return;
  }

  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not found');
});

httpServer.on('upgrade', (req, socket: Socket, head) => {
  const ip = req.socket.remoteAddress ?? '';
  if (!isLocalIP(ip)) {
    socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
    socket.destroy();
    return;
  }

  if (CONFIG.authToken) {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    const token = url.searchParams.get('token');
    if (token !== CONFIG.authToken) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }
  }

  if (wss.clients.size >= CONFIG.maxClients) {
    socket.write('HTTP/1.1 503 Service Unavailable\r\n\r\n');
    socket.destroy();
    return;
  }

  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit('connection', ws, req);
  });
});

wss.on('connection', (ws, req) => {
  clientFilters.set(ws, { paths: 'all' });
  const remote = req.socket.remoteAddress ?? 'unknown';
  log(`client connected from ${remote} (${wss.clients.size}/${CONFIG.maxClients})`);

  safeSend(ws, {
    name: RELAY_NAME,
    version: RELAY_VERSION,
    timestamp: new Date().toISOString(),
  });

  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw.toString());
      if (msg && typeof msg === 'object' && 'subscribe' in msg) {
        const sub = msg.subscribe;
        if (sub === 'all') {
          clientFilters.set(ws, { paths: 'all' });
        } else if (Array.isArray(sub)) {
          const paths = new Set<SignalKPath>();
          for (const item of sub) {
            if (item && typeof item.path === 'string') {
              paths.add(item.path as SignalKPath);
            }
          }
          clientFilters.set(ws, { paths });
        }
      }
    } catch {
      // SECURITY: never crash on hostile input. Ignore.
    }
  });

  ws.on('close', () => {
    clientFilters.delete(ws);
    log(`client disconnected (${wss.clients.size}/${CONFIG.maxClients})`);
  });

  ws.on('error', (err) => {
    log(`client error: ${err.message}`);
  });
});

httpServer.listen(CONFIG.wsPort, CONFIG.bindAddress, async () => {
  log(`Yachtly Helper v${RELAY_VERSION}: HTTP/WS on ${CONFIG.bindAddress}:${CONFIG.wsPort}`);
  log(`Discovery endpoint: http://${CONFIG.bindAddress}:${CONFIG.wsPort}/signalk`);
  log(`Auth: ${CONFIG.authToken ? 'token required' : 'disabled (set YACHTLY_RELAY_TOKEN to require a token)'}.`);
  log(`Supported NMEA sentences: ${SUPPORTED_SENTENCES.join(', ')}`);
  await orchestrator.start(broadcast, log);
});

function log(msg: string): void {
  const ts = new Date().toISOString();
  // eslint-disable-next-line no-console
  console.log(`[${ts}] ${msg}`);
}

const shutdown = async () => {
  log('shutting down...');
  await orchestrator.stop();
  for (const client of wss.clients) client.terminate();
  wss.close();
  httpServer.close();
  setTimeout(() => process.exit(0), 200);
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
