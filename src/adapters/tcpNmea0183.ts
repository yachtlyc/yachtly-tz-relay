/**
 * tcp-nmea0183 adapter — connects to an NMEA 0183 over TCP source and
 * streams Signal K deltas.
 *
 * Covers all five fingerprinted gateway families' navigation data:
 *   - Digital Yacht NavLink2     (default port 2000)
 *   - Yacht Devices YDWG-02      (default port 1456 in 0183 mode)
 *   - Simrad / B&G GoFree WIFI-1 (default port 2050)
 *   - Furuno TZtouch gateway     (default port 10110)
 *   - Actisense W2K-1            (0183 passthrough mode)
 *
 * All five expose the same wire format: `$` or `!` sentences followed by
 * newlines, the exact text the existing `nmeaToSignalK` parser handles.
 * That's why a single adapter covers five devices.
 */

import { Socket } from 'node:net';
import { nmeaToSignalK } from '../nmeaToSignalK.js';
import type {
  AdapterContext,
  AdapterProbe,
  AdapterStatus,
  VesselDataAdapter,
} from './index.js';

export interface TcpNmea0183Options {
  host: string;
  port: number;
  /** Human-friendly device label — e.g. "Digital Yacht NavLink2". */
  displayName?: string;
  /** How long to wait for first valid byte before giving up. */
  attachTimeoutMs?: number;
  /** Reconnect delay if the upstream drops the connection. */
  reconnectIntervalMs?: number;
}

const DEFAULT_ATTACH_TIMEOUT_MS = 3000;
const DEFAULT_RECONNECT_MS = 5000;

export class TcpNmea0183Adapter implements VesselDataAdapter {
  readonly status: AdapterStatus;
  private socket: Socket | null = null;
  private buffer = '';
  private reconnectTimer: NodeJS.Timeout | null = null;
  private stopped = false;

  constructor(private readonly opts: TcpNmea0183Options) {
    this.status = {
      id: `tcp-nmea0183:${opts.host}:${opts.port}`,
      type: 'tcp-nmea0183',
      displayName: opts.displayName ?? 'NMEA 0183 gateway',
      host: opts.host,
      port: opts.port,
      state: 'idle',
      attachedAt: null,
      lastError: null,
    };
  }

  async start(ctx: AdapterContext): Promise<void> {
    this.stopped = false;
    this.connect(ctx);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.socket) {
      this.socket.destroy();
      this.socket = null;
    }
    this.status.state = 'stopped';
  }

  private connect(ctx: AdapterContext): void {
    if (this.stopped) return;
    this.status.state = 'probing';
    const sock = new Socket();
    this.socket = sock;
    this.buffer = '';

    const attachTimeout = setTimeout(() => {
      if (this.status.state === 'probing') {
        this.status.state = 'failed';
        this.status.lastError = 'No NMEA sentences within attach timeout.';
        ctx.log(`tcp-nmea0183 ${this.opts.host}:${this.opts.port} no data; closing`);
        sock.destroy();
      }
    }, this.opts.attachTimeoutMs ?? DEFAULT_ATTACH_TIMEOUT_MS);

    sock.on('connect', () => {
      ctx.log(`tcp-nmea0183 connected to ${this.opts.host}:${this.opts.port}`);
    });

    sock.on('data', (chunk) => {
      this.buffer += chunk.toString('utf8');
      // NMEA sentences are line-delimited. Split on CR/LF, keep the last
      // (possibly partial) fragment in the buffer for the next chunk.
      const lines = this.buffer.split(/\r?\n/);
      this.buffer = lines.pop() ?? '';
      for (const line of lines) {
        if (!line) continue;
        const values = nmeaToSignalK(line);
        if (values.length > 0) {
          if (this.status.state !== 'attached') {
            this.status.state = 'attached';
            this.status.attachedAt = new Date().toISOString();
            this.status.lastError = null;
            clearTimeout(attachTimeout);
            ctx.log(`tcp-nmea0183 attached to ${this.opts.host}:${this.opts.port}`);
          }
          ctx.emit(values);
        }
      }
      // Guard runaway buffer growth on a misbehaving source.
      if (this.buffer.length > 64_000) this.buffer = '';
    });

    sock.on('error', (err) => {
      clearTimeout(attachTimeout);
      this.status.lastError = err.message;
      ctx.log(`tcp-nmea0183 ${this.opts.host}:${this.opts.port} error: ${err.message}`);
    });

    sock.on('close', () => {
      clearTimeout(attachTimeout);
      this.socket = null;
      if (this.stopped) return;
      // Reconnect if we were previously attached — the gateway may have
      // dropped the connection (Wi-Fi blip, brief power glitch). Don't
      // reconnect if we failed the initial probe; that endpoint isn't ours.
      if (this.status.state === 'attached') {
        this.status.state = 'probing';
        ctx.log(`tcp-nmea0183 ${this.opts.host}:${this.opts.port} dropped, reconnecting…`);
        this.reconnectTimer = setTimeout(
          () => this.connect(ctx),
          this.opts.reconnectIntervalMs ?? DEFAULT_RECONNECT_MS,
        );
      } else {
        this.status.state = 'failed';
      }
    });

    sock.connect(this.opts.port, this.opts.host);
  }
}

/**
 * Probe an endpoint for NMEA 0183 over TCP. Returns true if we received
 * at least one valid sentence within the timeout.
 *
 * Read-only: opens a socket, listens briefly, closes. No data sent.
 */
export const tcpNmea0183Probe: AdapterProbe = {
  type: 'tcp-nmea0183',
  probe(host, port, timeoutMs) {
    return new Promise<boolean>((resolve) => {
      const sock = new Socket();
      let buffer = '';
      let settled = false;

      const finish = (ok: boolean) => {
        if (settled) return;
        settled = true;
        sock.destroy();
        resolve(ok);
      };

      const t = setTimeout(() => finish(false), timeoutMs);

      sock.on('data', (chunk) => {
        buffer += chunk.toString('utf8');
        // Fast path: any `$` or `!` followed by an alpha tag, then a `,` is
        // good enough. Don't bother with checksums at probe time — being
        // lenient catches more devices.
        if (/[$!][A-Z]{2,5},/.test(buffer)) {
          clearTimeout(t);
          finish(true);
        }
        if (buffer.length > 4096) {
          clearTimeout(t);
          finish(false);
        }
      });

      sock.on('error', () => {
        clearTimeout(t);
        finish(false);
      });

      sock.on('close', () => {
        clearTimeout(t);
        finish(false);
      });

      sock.connect(port, host);
    });
  },
};

/**
 * Default port mappings per gateway family — used by the orchestrator's
 * auto-probe so we try the right port for each candidate host.
 */
export const TCP_NMEA0183_PORTS = [
  2000, // Digital Yacht NavLink2
  1456, // Yacht Devices YDWG-02 (0183 mode)
  2050, // Simrad / B&G GoFree
  10110, // Furuno TZtouch (and standard "NMEA over TCP" convention)
  10100, // Common alternate
] as const;
