# yachtly-tz-relay

A small read-only Node.js daemon — the **Yachtly Helper** — that bridges your vessel's data system to the Yachtly Connect dashboard. Auto-detects what you have, attaches to it, and serves the data as Signal K WebSocket deltas.

## Supported sources (as of v0.3.0)

| Source | Wire format | Default port | What you get |
|---|---|---|---|
| **TimeZero** | NMEA 0183 over UDP | 11101 | Full nav class (position, SOG/COG, heading, depth, wind, water temp, log) |
| **Digital Yacht NavLink2** | NMEA 0183 over TCP | 2000 | Full nav class |
| **Yacht Devices YDWG-02** (NMEA 0183 mode) | NMEA 0183 over TCP | 1456 | Full nav class |
| **Yacht Devices YDWG-02** (RAW N2K mode) | YDWG RAW over TCP | 1457 | Nav + **engine RPM/temp/oil/hours, fuel/water/black-water tank levels, battery V/A/SoC, rudder** |
| **Simrad / B&G GoFree WIFI-1** | NMEA 0183 over TCP | 2050 | Full nav class |
| **Furuno TZtouch gateway** | NMEA 0183 over TCP | 10110 | Full nav class |
| **Actisense W2K-1** (0183 passthrough) | NMEA 0183 over TCP | per device | Full nav class |

The helper auto-probes for every source above when it starts. Plug your gateway in, run the helper, and the dashboard sees data — no per-device configuration, no typing IPs.

> **Actisense W2K-1 in N2K binary mode**: deferred to a follow-up release. Use the W2K-1's NMEA 0183 passthrough output in the meantime — it covers all nav-class data.

## What it does NOT do

- **No write path.** The helper never sends data to any vessel bus. Client WebSocket messages are inspected only to read the initial subscribe filter — everything else is ignored.
- **No persistence.** State is in-memory only. Restart drops history; the helper re-discovers sources on the next boot.
- **No admin UI.** It's a one-process daemon. Configure with environment variables; status visible via `GET /helper/status`.
- **No NGX-1 USB N2K**. The NGX-1 is invisible to network discovery (USB only). Tracked as a separate adapter for a follow-up.

## Quickstart on a nav PC

Requires **Node.js 20+**.

```bash
cd yachtly-tz-relay
npm install
npm start
```

You should see something like:

```
[2026-05-13T10:00:00.000Z] Yachtly Helper v0.3.0: HTTP/WS on 0.0.0.0:8765
[2026-05-13T10:00:00.000Z] Discovery endpoint: http://0.0.0.0:8765/signalk
[2026-05-13T10:00:00.000Z] Auth: disabled (set YACHTLY_RELAY_TOKEN to require a token).
[2026-05-13T10:00:00.000Z] auto-probe: scanning 19 hosts (budget 5000ms)
[2026-05-13T10:00:00.000Z] udp-timezero listening on 0.0.0.0:11101
[2026-05-13T10:00:00.000Z] tcp-nmea0183 attached to 192.168.1.100:2000
[2026-05-13T10:00:00.000Z] auto-probe: 1 adapter(s) attached
```

The dashboard automatically finds the helper on `localhost:8765` (or any LAN IP) via the same discovery endpoint that v0.2.0 used. No URLs to copy or paste.

## Configuration

All via environment variables (see [.env.example](.env.example)):

| Variable | Default | Purpose |
|---|---|---|
| `YACHTLY_RELAY_UDP_PORT` | `11101` | UDP port to listen on (TimeZero default) |
| `YACHTLY_RELAY_WS_PORT` | `8765` | WebSocket + HTTP control port for dashboard clients |
| `YACHTLY_RELAY_MAX_CLIENTS` | `10` | Reject new WS clients beyond this many |
| `YACHTLY_RELAY_TOKEN` | _(empty)_ | When set, WS clients must include `?token=<value>` in the URL and `/helper/*` callers must send `Authorization: Bearer <value>` |
| `YACHTLY_RELAY_ENABLE_UDP_TIMEZERO` | `true` | Disable to skip the TimeZero UDP listener |
| `YACHTLY_RELAY_ENABLE_TCP_NMEA0183` | `true` | Disable to skip NMEA 0183 over TCP probes |
| `YACHTLY_RELAY_ENABLE_TCP_N2K_YD_RAW` | `true` | Disable to skip YDWG RAW probes |
| `YACHTLY_RELAY_ENABLE_TCP_N2K_ACTISENSE` | `true` | Reserved for the future Actisense binary adapter |
| `YACHTLY_RELAY_PROBE_TIMEOUT_MS` | `1500` | Per-target probe timeout |
| `YACHTLY_RELAY_PROBE_BUDGET_MS` | `5000` | Total auto-probe wall-clock budget |

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

## Helper control endpoints (new in v0.3.0)

Three small endpoints let the dashboard see what's connected and hand off newly-discovered gateways without anyone typing host:port. All gated by the local-network firewall and (when set) the bearer token.

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/helper/status` | List attached adapters with state + last auto-probe time. Used by the banner to know what's flowing. |
| `POST` | `/helper/sources` | Body `{ host, port, type? }`. Helper probes the endpoint and attaches the right adapter. Idempotent. Rate-limited to 10 req/min/IP. |
| `DELETE` | `/helper/sources/{id}` | Disconnect a single source by adapter id (from `/helper/status`). |

Older v0.2.0 dashboards don't know about these endpoints; they just keep using `/signalk` discovery and the WebSocket stream exactly as before. The new endpoints degrade silently — POST returns 404 against v0.2.0, which the banner treats as "no helper for gateway purposes" and falls back to its install CTA.

## Wire protocol

The helper emits the same delta shape the dashboard's `useVesselData` hook already consumes from `signalk-server`:

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
