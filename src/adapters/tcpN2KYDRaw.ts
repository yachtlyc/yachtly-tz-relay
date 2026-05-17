/**
 * tcp-n2k-yd-raw adapter — Yacht Devices RAW (N2K-over-TCP) format.
 *
 * YDWG-02 / YDWR-02 in "RAW" mode emit one line per CAN frame, with the
 * gateway performing Fast-Packet reassembly upstream. Each line:
 *
 *   `HH:MM:SS.mmm R 09F11201 12 34 56 78 9A BC DE F0`
 *
 * Where:
 *   - timestamp (optional, omitted on some firmware)
 *   - direction (T = received from bus, R = received as well — vendor uses R)
 *   - 8-hex-digit CAN ID (encodes priority, PGN, source address)
 *   - up to 8 hex bytes per CAN frame; Fast-Packet PGNs span multiple frames
 *     and the gateway emits one line per frame
 *
 * We do our own Fast-Packet reassembly here because the YD ASCII RAW format
 * does NOT pre-reassemble — each line is one CAN frame. The gateway's
 * sister format "YDRAW with reassembly" exists but isn't the default.
 *
 * Default port: 1457.
 */

import { Socket } from 'node:net';
import { n2kToSignalK } from '../n2kToSignalK.js';
import type {
  AdapterContext,
  AdapterProbe,
  AdapterStatus,
  VesselDataAdapter,
} from './index.js';
import type { SignalKValue } from '../nmeaToSignalK.js';

export interface TcpN2KYDRawOptions {
  host: string;
  port: number;
  displayName?: string;
  attachTimeoutMs?: number;
  reconnectIntervalMs?: number;
}

const DEFAULT_ATTACH_TIMEOUT_MS = 4000;
const DEFAULT_RECONNECT_MS = 5000;
const DEFAULT_PORT = 1457;

/** Maximum Fast-Packet payload (per spec): 223 bytes across 32 frames. */
const FP_MAX_PAYLOAD = 223;
const FP_MAX_FRAMES = 32;
const FP_TIMEOUT_MS = 5000;

interface FastPacketBuffer {
  expected: number;
  received: number;
  data: Uint8Array;
  lastSeen: number;
  /** Sequence id from the first frame's high nibble. */
  seq: number;
  /** Next expected frame number (0-based). */
  nextFrame: number;
}

/**
 * Parse a YDWG RAW line into (priority, PGN, source, data bytes).
 * Returns null on unrecognised format.
 */
export function parseYDRawLine(line: string): {
  pgn: number;
  source: number;
  data: Uint8Array;
} | null {
  // Trim timestamp + direction prefix. Two common shapes:
  //   "HH:MM:SS.mmm R CCCCCCCC BB BB ..."
  //   "R CCCCCCCC BB BB ..."
  const tokens = line.trim().split(/\s+/);
  if (tokens.length < 2) return null;

  // Find the CAN-ID token (8 hex chars). Skip leading timestamp + direction.
  let canIdIdx = -1;
  for (let i = 0; i < tokens.length; i++) {
    if (/^[0-9A-Fa-f]{8}$/.test(tokens[i])) {
      canIdIdx = i;
      break;
    }
  }
  if (canIdIdx < 0) return null;

  const canIdRaw = Number.parseInt(tokens[canIdIdx], 16);
  if (!Number.isFinite(canIdRaw)) return null;

  // N2K CAN-ID layout (29-bit):
  //   bits 0-7:   source address
  //   bits 8-15:  PS (PDU specific — destination or PGN-low)
  //   bits 16-23: PF (PDU format)
  //   bit  24:    DP (Data Page)
  //   bit  25:    R  (Reserved)
  //   bits 26-28: priority
  const source = canIdRaw & 0xff;
  const ps = (canIdRaw >> 8) & 0xff;
  const pf = (canIdRaw >> 16) & 0xff;
  const dp = (canIdRaw >> 24) & 0x01;

  // PGN derivation: if PF >= 0xF0 (PDU2), PGN = DP*0x10000 + PF*256 + PS.
  // Else PDU1 — PGN = DP*0x10000 + PF*256 (PS is destination).
  const pgn = pf < 0xf0 ? dp * 0x10000 + pf * 256 : dp * 0x10000 + pf * 256 + ps;

  const dataTokens = tokens.slice(canIdIdx + 1).filter((t) => /^[0-9A-Fa-f]{2}$/.test(t));
  if (dataTokens.length === 0) return null;

  const data = new Uint8Array(dataTokens.length);
  for (let i = 0; i < dataTokens.length; i++) {
    data[i] = Number.parseInt(dataTokens[i], 16) & 0xff;
  }

  return { pgn, source, data };
}

const FAST_PACKET_PGNS = new Set<number>([
  127489, // engine dynamic
]);

export class TcpN2KYDRawAdapter implements VesselDataAdapter {
  readonly status: AdapterStatus;
  private socket: Socket | null = null;
  private lineBuffer = '';
  private fpBuffers = new Map<string, FastPacketBuffer>();
  private reconnectTimer: NodeJS.Timeout | null = null;
  private stopped = false;

  constructor(private readonly opts: TcpN2KYDRawOptions) {
    this.status = {
      id: `tcp-n2k-yd-raw:${opts.host}:${opts.port}`,
      type: 'tcp-n2k-yd-raw',
      displayName: opts.displayName ?? 'Yacht Devices YDWG-02',
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
    this.lineBuffer = '';
    this.fpBuffers.clear();

    const attachTimeout = setTimeout(() => {
      if (this.status.state === 'probing') {
        this.status.state = 'failed';
        this.status.lastError = 'No valid YD RAW frames within attach timeout.';
        sock.destroy();
      }
    }, this.opts.attachTimeoutMs ?? DEFAULT_ATTACH_TIMEOUT_MS);

    sock.on('connect', () => {
      ctx.log(`tcp-n2k-yd-raw connected to ${this.opts.host}:${this.opts.port}`);
    });

    sock.on('data', (chunk) => {
      this.lineBuffer += chunk.toString('utf8');
      const lines = this.lineBuffer.split(/\r?\n/);
      this.lineBuffer = lines.pop() ?? '';
      for (const line of lines) {
        if (!line) continue;
        const frame = parseYDRawLine(line);
        if (!frame) continue;
        const values = this.ingestFrame(frame);
        if (values.length > 0) {
          if (this.status.state !== 'attached') {
            this.status.state = 'attached';
            this.status.attachedAt = new Date().toISOString();
            this.status.lastError = null;
            clearTimeout(attachTimeout);
            ctx.log(`tcp-n2k-yd-raw attached to ${this.opts.host}:${this.opts.port}`);
          }
          ctx.emit(values);
        }
      }
      if (this.lineBuffer.length > 64_000) this.lineBuffer = '';
    });

    sock.on('error', (err) => {
      clearTimeout(attachTimeout);
      this.status.lastError = err.message;
      ctx.log(`tcp-n2k-yd-raw ${this.opts.host}:${this.opts.port} error: ${err.message}`);
    });

    sock.on('close', () => {
      clearTimeout(attachTimeout);
      this.socket = null;
      if (this.stopped) return;
      if (this.status.state === 'attached') {
        this.status.state = 'probing';
        ctx.log(`tcp-n2k-yd-raw ${this.opts.host}:${this.opts.port} dropped, reconnecting…`);
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

  /**
   * Take one parsed CAN frame and return decoded Signal K values once a
   * complete N2K message is reassembled. Returns empty until a
   * single-frame PGN arrives or a Fast-Packet sequence finishes.
   */
  private ingestFrame(frame: {
    pgn: number;
    source: number;
    data: Uint8Array;
  }): SignalKValue[] {
    if (FAST_PACKET_PGNS.has(frame.pgn)) {
      return this.handleFastPacket(frame);
    }
    return n2kToSignalK(frame.pgn, frame.data);
  }

  private handleFastPacket(frame: {
    pgn: number;
    source: number;
    data: Uint8Array;
  }): SignalKValue[] {
    if (frame.data.length < 2) return [];
    const key = `${frame.pgn}:${frame.source}`;
    const byte0 = frame.data[0];
    // High nibble: sequence id; low nibble: frame number within the sequence.
    const seq = (byte0 >> 5) & 0x07;
    const frameNo = byte0 & 0x1f;

    // First frame carries a length byte at position 1.
    if (frameNo === 0) {
      const expected = frame.data[1];
      if (expected > FP_MAX_PAYLOAD) return [];
      const buf: FastPacketBuffer = {
        expected,
        received: 0,
        data: new Uint8Array(expected),
        lastSeen: Date.now(),
        seq,
        nextFrame: 1,
      };
      const payload = frame.data.subarray(2);
      const copyLen = Math.min(payload.length, expected);
      buf.data.set(payload.subarray(0, copyLen), 0);
      buf.received = copyLen;
      this.fpBuffers.set(key, buf);
      if (buf.received >= buf.expected) {
        this.fpBuffers.delete(key);
        return n2kToSignalK(frame.pgn, buf.data);
      }
      return [];
    }

    // Continuation frame.
    const buf = this.fpBuffers.get(key);
    if (!buf) return [];
    if (buf.seq !== seq || buf.nextFrame !== frameNo) {
      // Out-of-sequence — drop the partial assembly.
      this.fpBuffers.delete(key);
      return [];
    }
    if (Date.now() - buf.lastSeen > FP_TIMEOUT_MS) {
      this.fpBuffers.delete(key);
      return [];
    }
    if (buf.nextFrame > FP_MAX_FRAMES) {
      this.fpBuffers.delete(key);
      return [];
    }
    const payload = frame.data.subarray(1);
    const remaining = buf.expected - buf.received;
    const copyLen = Math.min(payload.length, remaining);
    buf.data.set(payload.subarray(0, copyLen), buf.received);
    buf.received += copyLen;
    buf.nextFrame += 1;
    buf.lastSeen = Date.now();
    if (buf.received >= buf.expected) {
      this.fpBuffers.delete(key);
      return n2kToSignalK(frame.pgn, buf.data);
    }
    return [];
  }
}

/**
 * Probe — open a TCP connection, look for one valid YD RAW line within
 * the timeout. Doesn't actually decode the PGN, just sniffs the format.
 */
export const tcpN2KYDRawProbe: AdapterProbe = {
  type: 'tcp-n2k-yd-raw',
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
        const lines = buffer.split(/\r?\n/);
        for (const line of lines) {
          if (parseYDRawLine(line) !== null) {
            clearTimeout(t);
            finish(true);
            return;
          }
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

export const TCP_N2K_YD_RAW_PORTS = [DEFAULT_PORT] as const;
