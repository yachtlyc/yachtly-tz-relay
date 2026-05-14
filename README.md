# yachtly-tz-relay

A small read-only Node.js daemon that listens to **TimeZero's UDP NMEA 0183 output** and re-serves it as **Signal K WebSocket deltas** for the Yachtly Connect dashboard.

Use this when you can't (or don't want to) install `signalk-server` on the nav PC. For most boats, `signalk-server` is the cleaner path — see [../docs/Yachtly Connect/on-vessel-test-setup.md](../docs/Yachtly%20Connect/on-vessel-test-setup.md) Step B. This relay is the Mode B fallback.

## What it does

- Binds a UDP listener (default port `11101`) to receive TimeZero NMEA 0183 sentences.
- Parses RMC, GGA, VTG, HDT, HDM, HDG, DBT, DPT, MWV, MWD, MDA, MTW, VLW, VHW.
- Converts each sentence to one or more Signal K `{path, value}` pairs (units: radians, m/s, Kelvin, Pa, metres, signed decimal degrees).
- Broadcasts the values as Signal K deltas over a WebSocket server (default port `8765`).
- Exposes a `GET /signalk` discovery endpoint on the same port so the dashboard can auto-detect the relay without the user typing an IP. CORS is open to any origin (the local-network gate is the real perimeter).
- Refuses non-local network clients at both the HTTP and WebSocket handshakes.

## What it does NOT do

- **No write path.** The relay never sends data to the NMEA bus. Client WebSocket messages are inspected only to read the initial subscribe filter — everything else is ignored.
- **No engine or tank data** in this phase. TimeZero's UDP output is typically navigation-class NMEA 0183 only; engine RPM, coolant temp, tank levels, etc. are usually on NMEA 2000. To capture those, you need a direct N2K bridge (Actisense NGX-1, YDWG-02). Backlog item #8.
- **No persistence.** State is in-memory only. Restart drops history.
- **No admin UI.** It's a one-process daemon. Configure with environment variables.

## Quickstart on a nav PC

Requires **Node.js 20+**.

```bash
cd yachtly-tz-relay
npm install
npm start
```

You should see:

```
[2026-05-13T10:00:00.000Z] Yachtly TZ Relay v0.2.0: UDP 11101 → HTTP/WS 8765
[2026-05-13T10:00:00.000Z] Discovery endpoint: http://0.0.0.0:8765/signalk
[2026-05-13T10:00:00.000Z] Read-only. Auth: disabled (set YACHTLY_RELAY_TOKEN to require a token).
[2026-05-13T10:00:00.000Z] Supported NMEA sentences: RMC, GGA, VTG, HDT, HDM, HDG, DBT, DPT, MWV, MWD, MDA, MTW, VLW, VHW
```

The dashboard's **Discover servers on this network** button (in the Connect settings panel) will probe `/signalk` and auto-fill the host/port fields when it finds the relay.

Then in Yachtly Connect (signed in), open the settings cog and enter:

- **Host**: the nav PC's local IP (e.g. `192.168.1.42`)
- **Port**: `8765`
- **Use TLS (WSS)**: off
- **Auth Token**: leave empty (see auth note below)

Apply. The status bar flips to "Live" within ~5 seconds.

## Configuration

All via environment variables (see [.env.example](.env.example)):

| Variable | Default | Purpose |
|---|---|---|
| `YACHTLY_RELAY_UDP_PORT` | `11101` | UDP port to listen on (TimeZero default) |
| `YACHTLY_RELAY_WS_PORT` | `8765` | WebSocket port for dashboard clients |
| `YACHTLY_RELAY_MAX_CLIENTS` | `10` | Reject new WS clients beyond this many |
| `YACHTLY_RELAY_TOKEN` | _(empty)_ | When set, clients must include `?token=<value>` in the WS URL |

You can use a `.env` file alongside the source — `dotenv` will pick it up.

## TimeZero output configuration

In TimeZero, enable NMEA 0183 UDP output:

1. **Options → Initial Setup → NMEA Output** (path varies by edition).
2. **Output**: UDP.
3. **Target address**: `255.255.255.255` (broadcast) — works regardless of the consumer's IP.
4. **Port**: `11101`.
5. Enable at minimum: **RMC, GGA, VTG, HDT/HDM, DBT/DPT, MWV**. Add MDA, MTW, VLW, MWD if your sensors emit them.

## Auth note for the Yachtly Connect dashboard

The dashboard currently sends its auth token inside the subscribe message body, not as a URL query string. The relay's `verifyClient` runs **before** any client message is received, so it expects the token in the URL.

**For now**: leave `YACHTLY_RELAY_TOKEN` empty when testing with the dashboard. The relay still refuses non-local-network connections, which is the most important guard.

If you want to lock the relay down to specific clients (e.g. a permanent boat installation with guest WiFi), set the token and connect with any WebSocket tool that puts the token in the URL. A small dashboard tweak is on the backlog to close this loop.

## Keep it running on the nav PC

For one-off testing, just leave the terminal window open. For longer-running use, wrap the process with [pm2](https://pm2.keymetrics.io/):

```bash
npm install -g pm2
pm2 start npm --name yachtly-tz-relay -- start
pm2 save
pm2 startup    # follow the printed instructions to enable boot-time start
```

## Scripts

| Script | Purpose |
|---|---|
| `npm start` | Run via `tsx` (no build step). Easiest. |
| `npm run build` | Compile TypeScript to `dist/` |
| `npm run start:prod` | Run the compiled JS in `dist/` (faster startup) |
| `npm test` | Run parser fixture tests (`node --test`) |
| `npm run typecheck` | TypeScript check, no emit |

## Wire protocol

The relay emits the same delta shape the dashboard's `useVesselData` hook already consumes from `signalk-server`:

```json
{
  "context": "vessels.self",
  "updates": [
    {
      "source": { "label": "yachtly-tz-relay", "type": "NMEA0183" },
      "timestamp": "2026-05-12T22:30:00.123Z",
      "values": [
        { "path": "navigation.position.latitude", "value": 28.2422 },
        { "path": "navigation.position.longitude", "value": -42.6315 },
        { "path": "navigation.speedOverGround", "value": 6.81 }
      ]
    }
  ]
}
```

A "hello" message is also sent on connect so clients can confirm they're talking to the relay (the dashboard reads `name` and `version` for its status bar):

```json
{ "name": "yachtly-tz-relay", "version": "0.1.0", "timestamp": "..." }
```

Clients send exactly one message worth processing: the subscribe filter.

```json
{ "context": "vessels.self", "subscribe": "all" }
```

or

```json
{
  "context": "vessels.self",
  "subscribe": [
    { "path": "navigation.position.latitude" },
    { "path": "navigation.position.longitude" }
  ]
}
```

All other client messages are silently ignored. The relay never lets client input affect the UDP listener.

## Security summary

- **Read-only on the NMEA side** — UDP is one-way ingest only.
- **Read-only on the WebSocket side** — clients can only subscribe; nothing is published back to NMEA.
- **Local-network-only** — clients from non-RFC-1918 IPs are refused with HTTP 403.
- **Optional shared-secret auth** via `YACHTLY_RELAY_TOKEN`.
- **Bounded resources** — `maxPayload: 1024`, `maxClients: 10` by default.
- **Crash-resistant parsing** — malformed sentences are dropped, never propagated.

See [the technical spec §3](../docs/Yachtly%20Connect/Yachtly-Connect-Technical-Spec-v0.1.md) for the full security model context.
