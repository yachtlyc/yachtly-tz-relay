# Yachtly Connect Helper — release runbook (for Will)

**Audience:** Will (or anyone with fast internet) building the helper binaries for an on-boat crew test.

**Why this exists:** Glenn set up the build pipeline on a metered satellite link and couldn't complete the one-time `pkg` Node-runtime fetch (~80 MB the first time). Everything else is in place — this runbook is the last-mile build + publish step.

---

## v0.3.0 — multi-source bridge (this release)

Adds support for **five fingerprinted gateway families** the dashboard's discovery banner had been detecting but couldn't consume in v0.2.0:

- Digital Yacht NavLink2 (NMEA 0183 over TCP, port 2000)
- Yacht Devices YDWG-02 (NMEA 0183 over TCP, port 1456 — **plus** YDWG RAW N2K over TCP, port 1457)
- Simrad / B&G GoFree WIFI-1 (NMEA 0183 over TCP, port 2050)
- Furuno TZtouch gateway (NMEA 0183 over TCP, port 10110)
- Actisense W2K-1 (NMEA 0183 passthrough mode)

YDWG-02 in N2K mode unlocks engine/tank/battery data (PGNs 127245, 127488, 127489, 127505, 127506, 127508) — the dashboard's Engine, Tanks & Electrical, and Steering tabs come alive on boats that have the gateway in RAW mode.

New helper-control endpoints (`GET /helper/status`, `POST /helper/sources`, `DELETE /helper/sources/{id}`) let the dashboard banner hand off any gateway it detects via browser-side HTTP fingerprinting. Backwards-compatible: v0.2.0 dashboards keep working through the unchanged `/signalk` discovery + WebSocket stream.

Closes Backlog item #8 for the NMEA 2000 → Signal K path via Yacht Devices RAW. **NGX-1 USB N2K stays open** — it's invisible to network discovery and needs a different adapter shape.

The Actisense W2K-1 binary N2K mode is deferred — its NMEA 0183 passthrough still works in v0.3.0 via the generic `tcp-nmea0183` adapter.

---

## What's already done

- `yachtly-tz-relay` is a Node 20 + TypeScript package that bridges multiple vessel-data sources to Signal K WebSocket deltas via an adapter interface.
- The ESM source is bundled to a single CJS file via `esbuild` for compatibility with `@yao-pkg/pkg`.
- Build config lives in `package.json` — `bundle`, `binaries`, and `binaries:mac-arm64` scripts.
- The bundle has been smoke-tested locally; the relay binds UDP 11101 + HTTP/WS 8765, exposes `/signalk` discovery, and runs end-to-end against a synthetic NMEA UDP packet (see `RELEASE.md` historical PR commits for evidence).
- The Yachtly Connect dashboard's settings panel + onboarding wizard already use the existing `signalKDiscovery` service to find this helper on the local network — once binaries are deployed and a crew member runs one, the dashboard will auto-discover.

## What you (Will) need to do

### 1. Pull and install

```bash
cd yachtly-tz-relay
npm install
```

This pulls `@yao-pkg/pkg`, `esbuild`, and the existing relay deps (`ws`, `dotenv`).

### 2. Smoke-test the bundle locally

```bash
npm run bundle
node build/yachtly-helper.cjs
```

Expected console output:

```
[<timestamp>] Yachtly Helper v0.3.0: HTTP/WS on 0.0.0.0:8765
[<timestamp>] Discovery endpoint: http://0.0.0.0:8765/signalk
[<timestamp>] Auth: disabled (set YACHTLY_RELAY_TOKEN to require a token).
[<timestamp>] auto-probe: scanning 19 hosts (budget 5000ms)
[<timestamp>] udp-timezero listening on 0.0.0.0:11101
[<timestamp>] auto-probe: 0 adapter(s) attached
```

(Zero adapters is normal on a dev machine with no real gateway on the network — the helper still serves the discovery endpoint + WebSocket so the dashboard can connect, and any TimeZero UDP packet from the boat will still feed through.)

`Ctrl+C` to stop.

### 3. Build the three binaries

```bash
npm run binaries
```

What happens:
- `esbuild` bundles `src/server.ts` → `build/yachtly-helper.cjs` (~62 KB, no external deps at runtime).
- `pkg` first run downloads the Node 20 base binaries (~80 MB total across Win-x64, macOS-arm64, macOS-x64) into `~/.pkg-cache/`. Subsequent runs reuse the cache.
- Output: `binaries/` contains three files, ~50–55 MB each (gzipped):

  ```
  binaries/
  ├── yachtly-helper-win-x64.exe
  ├── yachtly-helper-macos-arm64
  └── yachtly-helper-macos-x64
  ```

### 4. Rename for clarity before publishing

The dashboard's HelperInstallStep + crew install guide reference these filenames. Use these exact names so the dashboard's download links match:

```bash
cd binaries
mv yachtly-helper-win-x64.exe        yachtly-connect-helper-windows.exe
mv yachtly-helper-macos-arm64        yachtly-connect-helper-mac-apple-silicon
mv yachtly-helper-macos-x64          yachtly-connect-helper-mac-intel
```

### 5. Test each binary

On macOS (your build machine):
```bash
./binaries/yachtly-connect-helper-mac-apple-silicon
# or for an Intel Mac
./binaries/yachtly-connect-helper-mac-intel
```

Expected: identical startup log to step 2. `Ctrl+C` to stop.

If you have a Windows VM / box handy, copy `yachtly-connect-helper-windows.exe` over and double-click. Expected: a Command Prompt window opens with the same startup log.

If a Windows box isn't handy, ship anyway — the bundle has been verified locally and `pkg`'s cross-compilation is reliable for plain-Node apps like this one.

### 6. Publish to GitHub Releases

```bash
gh release create v0.3.0 \
  binaries/yachtly-connect-helper-windows.exe \
  binaries/yachtly-connect-helper-mac-apple-silicon \
  binaries/yachtly-connect-helper-mac-intel \
  --title "Yachtly Connect Helper v0.3.0 — multi-source bridge" \
  --notes "Multi-source bridge. Runs on the nav PC and auto-detects TimeZero UDP, plus NavLink2 / YDWG-02 (NMEA 0183 + RAW N2K) / GoFree / Furuno TZtouch / Actisense W2K-1 over TCP. Emits a single Signal K WebSocket stream for the Yachtly Connect dashboard.

**Unsigned** — first-run users will see a SmartScreen warning on Windows (click 'More info' → 'Run anyway') and a Gatekeeper prompt on macOS (right-click → Open the first time). Code-signing is queued for the Tauri rebuild follow-up.

Includes:
- yachtly-connect-helper-windows.exe (Windows x64)
- yachtly-connect-helper-mac-apple-silicon (macOS M1/M2/M3/M4)
- yachtly-connect-helper-mac-intel (macOS Intel)"
```

> Heads-up: don't paste the runbook's verbatim release notes into the public release unedited — earlier drafts referenced a local plan-file path. Keep release notes generic.

GitHub will produce three download URLs (the standalone `yachtlyc/yachtly-tz-relay` public repo — see "Repo divergence note" below):

```
https://github.com/yachtlyc/yachtly-tz-relay/releases/download/v0.3.0/yachtly-connect-helper-windows.exe
https://github.com/yachtlyc/yachtly-tz-relay/releases/download/v0.3.0/yachtly-connect-helper-mac-apple-silicon
https://github.com/yachtlyc/yachtly-tz-relay/releases/download/v0.3.0/yachtly-connect-helper-mac-intel
```

### 7. Update the dashboard with the real URLs

After publishing, search the codebase for `TBD-HELPER-DOWNLOAD-URL`:

```bash
git grep TBD-HELPER-DOWNLOAD-URL
```

You'll find them in:
- `app/yachtly-connect/components/onboarding/steps/HelperInstallStep.tsx` — three download buttons
- `docs/Yachtly Connect/crew-install-guide.md` — three download links

Replace each placeholder with the real GitHub release URL. Commit, push, deploy. The wizard's HelperInstallStep then ships with working download buttons.

### 8. Sanity-check the boat-test flow

End-to-end:
1. On a fresh machine (or a colleague's machine), open the dashboard → sign in → wizard auto-launches.
2. Pick **No** to "Signal K device", **Yes** to "TimeZero", click through TimeZero output step.
3. Helper-install step now shows three real download buttons.
4. Download the platform binary, run it, dismiss SmartScreen/Gatekeeper.
5. Click "Scan again" in the wizard's Discover step — the binary's `/signalk` endpoint responds, the wizard finds it, click **Connect →**.
6. Dashboard flips to LIVE. Done.

If any step fails, fall back to the dev-test setup at `docs/Yachtly Connect/on-vessel-test-setup.md` Step C (manual relay run) to diagnose.

---

## Repo divergence note (added after v0.2.0)

The v0.2.0 release was published to a **separate public repo** at
[`yachtlyc/yachtly-tz-relay`](https://github.com/yachtlyc/yachtly-tz-relay/releases) rather than under `will8688/Yachtly-Crew/releases/`. The local `gh` token authenticates as `yachtlyc` and doesn't have write access to the `will8688` monorepo; the standalone helper repo is also architecturally cleaner (helper is its own product, doesn't bloat the main app repo with ~150 MB of binaries per release).

Consequence: relay source now lives in two places — `yachtly-tz-relay/` inside this monorepo (development), and `yachtlyc/yachtly-tz-relay` on GitHub (release-tagged copy). Future relay changes need mirroring across, or pick one as source of truth. See `yachtly-tz-relay/HANDOFF-TO-GLENN.md` for the full context Will captured at release time.

---

## Notes for the next iteration (Option B — Tauri full installer)

The crew-onboarding strategy plan calls out a follow-up replacing this pkg approach with a proper Tauri-wrapped system-tray app:

- Code-signed on Windows (EV cert, ~$300/yr) and notarised on macOS (Apple Developer Programme — already a Yachtly Crew cost).
- System tray icon with Open / Quit / Uninstall.
- Auto-update via Tauri's updater.
- Drops the console window — looks like installing Whatsapp instead of a CLI tool.

Out of scope for this MVP test. Trigger when public launch is on the horizon.

---

## Troubleshooting

**`pkg` fails on the macOS-x64 target with "no Node 20 binary found"**
Run `pkg --help` and check the supported targets; `@yao-pkg/pkg` 6.6+ supports `node20-macos-x64`. If you're on an older fork, upgrade.

**Binary runs but the dashboard can't find it via Scan**
- Check the binary's console output for the actual port (default 8765).
- Confirm the dashboard and the nav PC are on the same local network.
- Check Windows Defender Firewall — first run usually prompts; allow on "Private network".
- The local-network gate is strict; connections from non-RFC-1918 IPs are refused at the TCP handshake.

**Mac binary won't launch (Gatekeeper)**
This is expected for the unsigned build. Right-click → Open the first time, then it's trusted thereafter. We'll document this in the crew install guide.

**Boundary check: does the binary actually contain the bundled JS, or is it pointing at a path?**
`pkg` embeds the bundled JS inside the executable; no external file is required at runtime. Verify with `strings <binary> | grep -i yachtly` — you should see strings from the bundle inline.

---

*Generated as part of the Tier 1 #3 crew-onboarding work. Glenn handed off because of metered satellite bandwidth on the boat. Build, publish, point the dashboard at the new URLs, and the boat test is live.*
