/**
 * Orchestrator — owns the lifecycle of every adapter the helper runs.
 *
 * Responsibilities:
 *   - On boot, run an auto-probe sweep against a tight candidate list of
 *     LAN hosts + ports, then start an adapter for every endpoint that
 *     looks live.
 *   - Always start the TimeZero UDP listener (it's a passive bind, no
 *     probe needed).
 *   - Accept ad-hoc attach/detach requests from the helper's HTTP control
 *     surface so the browser can hand off newly-discovered gateways.
 *   - Surface adapter state to the `/helper/status` endpoint.
 *
 * The orchestrator never holds references to the WS server — it talks to
 * the broadcast surface only via a `broadcast(values)` callback wired by
 * server.ts. Keeps the code mockable and testable.
 */

import type { SignalKValue } from './nmeaToSignalK.js';
import type {
  AdapterContext,
  AdapterProbe,
  AdapterStatus,
  AdapterType,
  VesselDataAdapter,
} from './adapters/index.js';
import { UdpTimeZeroAdapter } from './adapters/udpTimeZero.js';
import {
  TcpNmea0183Adapter,
  tcpNmea0183Probe,
  TCP_NMEA0183_PORTS,
} from './adapters/tcpNmea0183.js';
import {
  TcpN2KYDRawAdapter,
  tcpN2KYDRawProbe,
  TCP_N2K_YD_RAW_PORTS,
} from './adapters/tcpN2KYDRaw.js';

/**
 * LAN hosts the orchestrator probes at boot. Mirrors the browser's list in
 * `app/yachtly-connect/services/vesselDiscovery.ts` so the helper and the
 * dashboard look in the same places.
 *
 * Tight on purpose — a full /24 sweep would saturate weak boat Wi-Fi.
 * Most marine gateways ship from these IPs out of the box.
 */
const PROBE_HOSTNAMES = [
  'signalk.local',
  'openplotter.local',
  'venus.local',
  'cerbo.local',
  'raspberrypi.local',
  'navpc.local',
  'nav-pc.local',
] as const;

const PROBE_LAN_IPS = [
  '192.168.1.1',
  '192.168.1.2',
  '192.168.1.10',
  '192.168.1.100',
  '192.168.1.105',
  '192.168.0.1',
  '192.168.0.2',
  '192.168.0.10',
  '192.168.0.100',
  '10.0.0.1',
  '10.10.10.1',
  '172.16.0.1',
] as const;

const DEFAULT_PROBE_TIMEOUT_MS = 1500;
const DEFAULT_PROBE_BUDGET_MS = 5000;

export interface OrchestratorOptions {
  /** Bind address for the TimeZero UDP listener. */
  udpBindAddress: string;
  udpPort: number;
  /** Per-adapter enable flags — env-var driven. */
  enable: Record<AdapterType, boolean>;
  /** Per-target probe timeout. */
  probeTimeoutMs?: number;
  /** Total auto-probe budget. */
  probeBudgetMs?: number;
  /** Mock candidate list for tests. Defaults to the real hostname + IP list. */
  probeTargets?: ReadonlyArray<string>;
}

export interface AttachResult {
  ok: boolean;
  status?: AdapterStatus;
  error?: string;
}

export class Orchestrator {
  private readonly adapters = new Map<string, VesselDataAdapter>();
  private lastAutoProbe: string | null = null;
  private ctx: AdapterContext | null = null;

  constructor(private readonly opts: OrchestratorOptions) {}

  /**
   * Wire the orchestrator to its broadcast surface and start every
   * adapter. Always returns — never throws; failed adapters are recorded
   * in `status`.
   */
  async start(emit: (values: SignalKValue[]) => void, log: (msg: string) => void): Promise<void> {
    this.ctx = { emit, log };

    if (this.opts.enable['udp-timezero']) {
      const adapter = new UdpTimeZeroAdapter({
        bindAddress: this.opts.udpBindAddress,
        port: this.opts.udpPort,
      });
      this.adapters.set(adapter.status.id, adapter);
      await adapter.start(this.ctx);
    }

    if (this.opts.enable['tcp-nmea0183'] || this.opts.enable['tcp-n2k-yd-raw']) {
      await this.autoProbe();
    }
  }

  async stop(): Promise<void> {
    const work: Promise<void>[] = [];
    for (const adapter of this.adapters.values()) work.push(adapter.stop());
    await Promise.allSettled(work);
    this.adapters.clear();
  }

  /**
   * Auto-probe the candidate list in parallel within a bounded budget.
   * Every successful probe spawns an adapter that stays attached.
   */
  private async autoProbe(): Promise<void> {
    if (!this.ctx) return;
    const timeoutMs = this.opts.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
    const budgetMs = this.opts.probeBudgetMs ?? DEFAULT_PROBE_BUDGET_MS;

    const hosts: ReadonlyArray<string> =
      this.opts.probeTargets ?? [...PROBE_HOSTNAMES, ...PROBE_LAN_IPS];

    this.ctx.log(`auto-probe: scanning ${hosts.length} hosts (budget ${budgetMs}ms)`);

    const tasks: Array<Promise<void>> = [];
    for (const host of hosts) {
      if (this.opts.enable['tcp-nmea0183']) {
        for (const port of TCP_NMEA0183_PORTS) {
          tasks.push(
            this.tryAttach(host, port, 'tcp-nmea0183', timeoutMs).then(() => undefined),
          );
        }
      }
      if (this.opts.enable['tcp-n2k-yd-raw']) {
        for (const port of TCP_N2K_YD_RAW_PORTS) {
          tasks.push(
            this.tryAttach(host, port, 'tcp-n2k-yd-raw', timeoutMs).then(() => undefined),
          );
        }
      }
    }

    // Race the full task set against the global budget — if some probes
    // take their full 1.5s and we have 84 of them, total wall time stays
    // ~5s thanks to parallelism + timeout. The budget caps the worst case.
    await Promise.race([
      Promise.allSettled(tasks),
      new Promise((resolve) => setTimeout(resolve, budgetMs)),
    ]);

    this.lastAutoProbe = new Date().toISOString();
    this.ctx.log(`auto-probe: ${this.attachedCount()} adapter(s) attached`);
  }

  /**
   * Probe + attach a single endpoint. Public so the HTTP /helper/sources
   * handler can call it for browser-handed-off candidates.
   *
   * If `type` is omitted, races every known probe.
   */
  async tryAttach(
    host: string,
    port: number,
    type: AdapterType | undefined,
    timeoutMs: number,
  ): Promise<AttachResult> {
    if (!this.ctx) return { ok: false, error: 'orchestrator not started' };

    // Already attached? Idempotent — return current status.
    for (const adapter of this.adapters.values()) {
      if (adapter.status.host === host && adapter.status.port === port) {
        return { ok: true, status: adapter.status };
      }
    }

    const probesToRun: AdapterProbe[] = type
      ? [pickProbe(type)].filter((p): p is AdapterProbe => p !== null)
      : ALL_PROBES;

    if (probesToRun.length === 0) {
      return { ok: false, error: `unknown or unsupported adapter type: ${type}` };
    }

    for (const probe of probesToRun) {
      const ok = await probe.probe(host, port, timeoutMs);
      if (!ok) continue;
      const adapter = buildAdapter(probe.type, host, port);
      if (!adapter) continue;
      this.adapters.set(adapter.status.id, adapter);
      await adapter.start(this.ctx);
      return { ok: true, status: adapter.status };
    }

    return { ok: false, error: 'no adapter matched this endpoint' };
  }

  async detach(id: string): Promise<boolean> {
    const adapter = this.adapters.get(id);
    if (!adapter) return false;
    await adapter.stop();
    this.adapters.delete(id);
    return true;
  }

  /** Snapshot for the `/helper/status` endpoint. */
  statusSnapshot(): { adapters: AdapterStatus[]; lastAutoProbe: string | null } {
    return {
      adapters: [...this.adapters.values()].map((a) => ({ ...a.status })),
      lastAutoProbe: this.lastAutoProbe,
    };
  }

  private attachedCount(): number {
    let n = 0;
    for (const a of this.adapters.values()) if (a.status.state === 'attached') n++;
    return n;
  }
}

// Probe order matters when the caller omits `type` in POST /helper/sources:
// the N2K probe runs first because its frame format is stricter (any
// match implies the device really is YD RAW), and tcp-nmea0183 is the
// permissive catch-all that matches anything emitting `$`/`!` sentences.
const ALL_PROBES: AdapterProbe[] = [tcpN2KYDRawProbe, tcpNmea0183Probe];

function pickProbe(type: AdapterType): AdapterProbe | null {
  if (type === 'tcp-nmea0183') return tcpNmea0183Probe;
  if (type === 'tcp-n2k-yd-raw') return tcpN2KYDRawProbe;
  // udp-timezero is not probed — it's a singleton passive listener.
  // tcp-n2k-actisense (binary framing) is deferred to a follow-up; W2K-1
  // users get nav data via tcp-nmea0183 in the meantime.
  return null;
}

function buildAdapter(
  type: AdapterType,
  host: string,
  port: number,
): VesselDataAdapter | null {
  if (type === 'tcp-nmea0183') return new TcpNmea0183Adapter({ host, port });
  if (type === 'tcp-n2k-yd-raw') return new TcpN2KYDRawAdapter({ host, port });
  return null;
}
