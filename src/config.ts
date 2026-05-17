import 'dotenv/config';

const parseInt10 = (raw: string | undefined, fallback: number): number => {
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

const parseBool = (raw: string | undefined, fallback: boolean): boolean => {
  if (raw === undefined) return fallback;
  const v = raw.trim().toLowerCase();
  if (v === 'false' || v === '0' || v === 'no' || v === 'off') return false;
  if (v === 'true' || v === '1' || v === 'yes' || v === 'on') return true;
  return fallback;
};

/**
 * Per-adapter env-var flags. Defaults: every adapter on. Override to
 * `false` in `.env` to disable an adapter family without touching code —
 * useful on boats where, say, the YDWG-02 is the only feed and we want to
 * skip wasted TimeZero probing.
 */
const enable = {
  udpTimeZero: parseBool(process.env.YACHTLY_RELAY_ENABLE_UDP_TIMEZERO, true),
  tcpNmea0183: parseBool(process.env.YACHTLY_RELAY_ENABLE_TCP_NMEA0183, true),
  tcpN2KYDRaw: parseBool(process.env.YACHTLY_RELAY_ENABLE_TCP_N2K_YD_RAW, true),
  tcpN2KActisense: parseBool(process.env.YACHTLY_RELAY_ENABLE_TCP_N2K_ACTISENSE, true),
} as const;

export const CONFIG = {
  udpPort: parseInt10(process.env.YACHTLY_RELAY_UDP_PORT, 11101),
  wsPort: parseInt10(process.env.YACHTLY_RELAY_WS_PORT, 8765),
  maxClients: parseInt10(process.env.YACHTLY_RELAY_MAX_CLIENTS, 10),
  authToken: (process.env.YACHTLY_RELAY_TOKEN ?? '').trim(),
  bindAddress: '0.0.0.0',
  enable,
  /** Per-target probe timeout (ms). Tests can override via env. */
  probeTimeoutMs: parseInt10(process.env.YACHTLY_RELAY_PROBE_TIMEOUT_MS, 1500),
  /** Total auto-probe budget (ms). */
  probeBudgetMs: parseInt10(process.env.YACHTLY_RELAY_PROBE_BUDGET_MS, 5000),
} as const;
