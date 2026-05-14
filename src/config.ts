import 'dotenv/config';

const parseInt10 = (raw: string | undefined, fallback: number): number => {
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

export const CONFIG = {
  udpPort: parseInt10(process.env.YACHTLY_RELAY_UDP_PORT, 11101),
  wsPort: parseInt10(process.env.YACHTLY_RELAY_WS_PORT, 8765),
  maxClients: parseInt10(process.env.YACHTLY_RELAY_MAX_CLIENTS, 10),
  authToken: (process.env.YACHTLY_RELAY_TOKEN ?? '').trim(),
  bindAddress: '0.0.0.0',
} as const;
