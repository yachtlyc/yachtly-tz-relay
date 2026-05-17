/**
 * udp-timezero adapter — listens for NMEA 0183 lines on a UDP port (default
 * 11101, TimeZero's output port) and emits them as Signal K deltas.
 *
 * This is the original v0.2.0 ingest path moved verbatim behind the adapter
 * interface. Behaviour is unchanged: bind, read, parse, emit. The only
 * difference is the orchestrator owns the lifecycle.
 */

import { createSocket, type Socket } from 'node:dgram';
import { nmeaToSignalK } from '../nmeaToSignalK.js';
import type { AdapterContext, AdapterStatus, VesselDataAdapter } from './index.js';

export interface UdpTimeZeroOptions {
  bindAddress: string;
  port: number;
}

export class UdpTimeZeroAdapter implements VesselDataAdapter {
  readonly status: AdapterStatus;
  private socket: Socket | null = null;

  constructor(private readonly opts: UdpTimeZeroOptions) {
    this.status = {
      id: `udp-timezero:${opts.bindAddress}:${opts.port}`,
      type: 'udp-timezero',
      displayName: 'TimeZero',
      host: opts.bindAddress,
      port: opts.port,
      state: 'idle',
      attachedAt: null,
      lastError: null,
    };
  }

  start(ctx: AdapterContext): Promise<void> {
    return new Promise((resolve) => {
      this.status.state = 'probing';
      const sock = createSocket('udp4');
      this.socket = sock;

      sock.on('message', (buf) => {
        const text = buf.toString('utf8');
        const lines = text.split(/\r?\n/);
        for (const line of lines) {
          if (!line) continue;
          const values = nmeaToSignalK(line);
          if (values.length > 0) {
            // First successful parse promotes the adapter to attached.
            if (this.status.state !== 'attached') {
              this.status.state = 'attached';
              this.status.attachedAt = new Date().toISOString();
              ctx.log(`udp-timezero attached on ${this.opts.bindAddress}:${this.opts.port}`);
            }
            ctx.emit(values);
          } else if (line.startsWith('$') || line.startsWith('!')) {
            ctx.log(`udp-timezero unmapped sentence: ${line.slice(0, 20)}...`);
          }
        }
      });

      sock.on('error', (err) => {
        this.status.state = 'failed';
        this.status.lastError = err.message;
        ctx.log(`udp-timezero error: ${err.message}`);
      });

      sock.bind(this.opts.port, this.opts.bindAddress, () => {
        // Successful bind only means we're listening — `attached` waits for
        // the first valid sentence so the dashboard can distinguish "helper
        // is running but no data" from "data flowing."
        ctx.log(`udp-timezero listening on ${this.opts.bindAddress}:${this.opts.port}`);
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    if (!this.socket) return;
    return new Promise((resolve) => {
      this.socket!.close(() => {
        this.socket = null;
        this.status.state = 'stopped';
        resolve();
      });
    });
  }
}
