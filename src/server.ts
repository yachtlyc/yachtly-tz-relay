/**
 * Yachtly TZ Relay — UDP NMEA 0183 → Signal K WebSocket bridge.
 *
 * SECURITY MODEL (spec §5):
 *   - Read-only. Incoming client WebSocket messages are inspected ONLY to
 *     read the initial `subscribe` payload (path filter). No client message
 *     can influence the UDP listener or relay state.
 *   - Local-network-only. HTTP + WebSocket clients from non-RFC-1918 IPs
 *     are refused with 403.
 *   - Optional shared-secret token (`YACHTLY_RELAY_TOKEN`). When set, WS
 *     clients must pass `?token=...` in the URL. The HTTP /signalk
 *     discovery endpoint stays open so dashboards can find the relay.
 *   - `maxPayload: 1024` — clients can't send anything large.
 *   - Malformed NMEA sentences are logged (first 20 chars) and dropped.
 */

import { createSocket } from 'node:dgram';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { Socket } from 'node:net';
import { WebSocketServer, WebSocket } from 'ws';
import { CONFIG } from './config.js';
import { isLocalIP } from './localIp.js';
import { nmeaToSignalK, SUPPORTED_SENTENCES, type SignalKValue } from './nmeaToSignalK.js';
import type { SignalKPath } from './paths.js';

const RELAY_NAME = 'yachtly-tz-relay';
const RELAY_VERSION = '0.2.0';

interface ClientFilter {
  paths: Set<SignalKPath> | 'all';
}

function applyCorsHeaders(res: ServerResponse): void {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

function buildDiscoveryPayload(hostHeader: string | undefined): Record<string, unknown> {
  // Reflect the host:port the client connected to so the dashboard knows
  // exactly where to point its WebSocket. Falls back to the configured port.
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

const httpServer = createServer((req: IncomingMessage, res: ServerResponse) => {
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

  // Signal-K-compatible discovery endpoint. Lets the Yachtly Connect
  // dashboard (and any other Signal K client) find the relay via a single
  // GET, identically to how it'd find a real signalk-server.
  if (req.method === 'GET' && (req.url === '/signalk' || req.url === '/signalk/')) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(buildDiscoveryPayload(req.headers.host)));
    return;
  }

  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not found');
});

const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 });

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

const clientFilters = new WeakMap<WebSocket, ClientFilter>();

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

function safeSend(ws: WebSocket, obj: unknown): void {
  if (ws.readyState !== WebSocket.OPEN) return;
  try {
    ws.send(JSON.stringify(obj));
  } catch (err) {
    log(`send failed: ${(err as Error).message}`);
  }
}

function broadcast(values: SignalKValue[]): void {
  if (values.length === 0) return;
  const timestamp = new Date().toISOString();
  const delta = {
    context: 'vessels.self',
    updates: [
      {
        source: { label: RELAY_NAME, type: 'NMEA0183' },
        timestamp,
        values,
      },
    ],
  };
  const fullJson = JSON.stringify(delta);

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

function safeSendRaw(ws: WebSocket, json: string): void {
  if (ws.readyState !== WebSocket.OPEN) return;
  try {
    ws.send(json);
  } catch (err) {
    log(`send failed: ${(err as Error).message}`);
  }
}

const udp = createSocket('udp4');

udp.on('message', (buf) => {
  const text = buf.toString('utf8');
  const lines = text.split(/\r?\n/);
  for (const line of lines) {
    if (!line) continue;
    const values = nmeaToSignalK(line);
    if (values.length > 0) {
      broadcast(values);
    } else if (line.startsWith('$') || line.startsWith('!')) {
      log(`unmapped sentence: ${line.slice(0, 20)}...`);
    }
  }
});

udp.on('error', (err) => {
  log(`UDP error: ${err.message}`);
});

httpServer.listen(CONFIG.wsPort, CONFIG.bindAddress, () => {
  udp.bind(CONFIG.udpPort, CONFIG.bindAddress, () => {
    log(`Yachtly TZ Relay v${RELAY_VERSION}: UDP ${CONFIG.udpPort} → HTTP/WS ${CONFIG.wsPort}`);
    log(`Discovery endpoint: http://${CONFIG.bindAddress}:${CONFIG.wsPort}/signalk`);
    log(`Read-only. Auth: ${CONFIG.authToken ? 'token required' : 'disabled (set YACHTLY_RELAY_TOKEN to require a token)'}.`);
    log(`Supported NMEA sentences: ${SUPPORTED_SENTENCES.join(', ')}`);
  });
});

function log(msg: string): void {
  const ts = new Date().toISOString();
  // eslint-disable-next-line no-console
  console.log(`[${ts}] ${msg}`);
}

const shutdown = () => {
  log('shutting down...');
  for (const client of wss.clients) client.terminate();
  wss.close();
  httpServer.close();
  udp.close();
  setTimeout(() => process.exit(0), 200);
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
