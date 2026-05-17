/**
 * Adapter interface — the contract every input source implements so the
 * orchestrator can manage its lifecycle uniformly.
 *
 * An adapter wraps one input (UDP listener, TCP connection to a gateway,
 * future USB serial port, etc.) and emits Signal K values via the shared
 * `emit` callback that the orchestrator wires to `server.broadcast()`.
 *
 * Adapters are passive once started: they push values when the underlying
 * source delivers them. They never poll the orchestrator, and they hold no
 * reference to the WS server — that decoupling is what lets us mock them in
 * tests and add new input types without touching server.ts.
 */

import type { SignalKValue } from '../nmeaToSignalK.js';

export type AdapterType =
  | 'udp-timezero'
  | 'tcp-nmea0183'
  | 'tcp-n2k-yd-raw'
  | 'tcp-n2k-actisense';

export type AdapterState =
  | 'idle'
  /** Probing the endpoint, not yet known good/bad. */
  | 'probing'
  /** Connected and emitting values. */
  | 'attached'
  /** Tried and failed (network unreachable, format mismatch, etc.). */
  | 'failed'
  /** Stopped by the orchestrator (explicit `stop()` call). */
  | 'stopped';

export interface AdapterStatus {
  /** Stable instance id, e.g. `tcp-nmea0183:192.168.1.2:2000`. */
  readonly id: string;
  readonly type: AdapterType;
  /** Human-friendly label for `/helper/status` and the dashboard banner. */
  readonly displayName: string;
  /** Endpoint host. For TimeZero (UDP bind) this is the bind address. */
  readonly host: string;
  readonly port: number;
  state: AdapterState;
  /** ISO-8601 timestamp of when the adapter first attached, or null. */
  attachedAt: string | null;
  /** Last error message, surfaced via `/helper/status` for debugging. */
  lastError: string | null;
}

export interface AdapterContext {
  /** Push Signal K values out to all subscribed WS clients. */
  emit: (values: SignalKValue[]) => void;
  /** Log a one-line message — orchestrator decides where it goes. */
  log: (msg: string) => void;
}

export interface VesselDataAdapter {
  readonly status: AdapterStatus;
  /**
   * Bring the adapter online. For network adapters: connect, validate the
   * wire format, transition to `attached` on first successful frame.
   *
   * Resolves once the adapter is either attached or has irrecoverably
   * failed — never throws. Inspect `status.state` after.
   */
  start(ctx: AdapterContext): Promise<void>;
  /** Tear down. Idempotent. */
  stop(): Promise<void>;
}

/**
 * Probe a single host:port to see if an adapter of this type can attach.
 * Used by the orchestrator's boot-time auto-probe and by the
 * `POST /helper/sources` endpoint when the browser hands off a candidate
 * without a type hint.
 *
 * Probes are read-only: they open a socket, peek at the wire format, and
 * close — they never alter the upstream device's state.
 */
export interface AdapterProbe {
  readonly type: AdapterType;
  probe(host: string, port: number, timeoutMs: number): Promise<boolean>;
}
