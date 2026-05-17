/**
 * Orchestrator integration tests — spin up a tiny local TCP server that
 * impersonates an NMEA 0183 gateway, then verify the orchestrator's
 * probe + attach + emit pipeline against it end-to-end.
 *
 * We bind to 127.0.0.1:0 (ephemeral port) so the test never collides with
 * other things on the host and never reaches outside the loopback.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:net';
import { Orchestrator } from '../src/orchestrator.js';
import type { SignalKValue } from '../src/nmeaToSignalK.js';

async function startMockNmea0183Server(): Promise<{ server: Server; port: number }> {
  const server = createServer((socket) => {
    // Swallow socket-level errors — when the test tears down the adapter the
    // server's end of the connection sees ECONNRESET, which otherwise bubbles
    // up as an uncaughtException and fails the test.
    socket.on('error', () => {});
    const lines = [
      '$GPGGA,123519,4807.038,N,01131.000,E,1,08,0.9,545.4,M,46.9,M,,*47',
      '$GPRMC,123519,A,4807.038,N,01131.000,E,022.4,084.4,230394,003.1,W*6A',
    ];
    for (const line of lines) socket.write(line + '\r\n');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('no address');
  return { server, port: addr.port };
}

test('orchestrator attaches to a live NMEA 0183 endpoint and emits values', async () => {
  const { server, port } = await startMockNmea0183Server();
  const emitted: SignalKValue[][] = [];

  const orch = new Orchestrator({
    udpBindAddress: '127.0.0.1',
    udpPort: 0, // unused: udp-timezero disabled in this test
    enable: {
      'udp-timezero': false,
      'tcp-nmea0183': true,
      'tcp-n2k-yd-raw': false,
      'tcp-n2k-actisense': false,
    },
    probeTimeoutMs: 500,
    probeBudgetMs: 2000,
    probeTargets: ['127.0.0.1'],
  });

  // Custom target list is just 127.0.0.1, but the orchestrator's port list
  // includes 2000/1456/2050/10110/10100 — none of which match our ephemeral
  // port. So auto-probe naturally misses; we hand off via tryAttach.
  await orch.start(
    (values) => emitted.push(values),
    () => {},
  );
  const result = await orch.tryAttach('127.0.0.1', port, 'tcp-nmea0183', 1000);

  assert.equal(result.ok, true, `tryAttach should succeed: ${result.error}`);
  assert.equal(result.status?.type, 'tcp-nmea0183');

  // Give the data event a tick to fire and `emit` to be called.
  await new Promise((r) => setTimeout(r, 100));

  assert.ok(emitted.length > 0, 'orchestrator should have emitted at least one batch');
  const allPaths = emitted.flat().map((v) => v.path);
  assert.ok(
    allPaths.some((p) => p.startsWith('navigation.')),
    `expected navigation paths, got: ${allPaths.join(', ')}`,
  );

  await orch.stop();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

test('orchestrator rejects an endpoint that does not match any adapter', async () => {
  // Server that emits gibberish — nothing should attach.
  const garbage = createServer((s) => s.write('garbage data not nmea\n'));
  await new Promise<void>((resolve) => garbage.listen(0, '127.0.0.1', resolve));
  const addr = garbage.address();
  if (!addr || typeof addr === 'string') throw new Error('no address');

  const orch = new Orchestrator({
    udpBindAddress: '127.0.0.1',
    udpPort: 0,
    enable: {
      'udp-timezero': false,
      'tcp-nmea0183': true,
      'tcp-n2k-yd-raw': true,
      'tcp-n2k-actisense': false,
    },
    probeTimeoutMs: 500,
    probeBudgetMs: 1000,
    probeTargets: [],
  });
  await orch.start(
    () => {},
    () => {},
  );
  const result = await orch.tryAttach('127.0.0.1', addr.port, undefined, 500);
  assert.equal(result.ok, false);

  await orch.stop();
  await new Promise<void>((resolve) => garbage.close(() => resolve()));
});

test('orchestrator returns existing status when tryAttach is called twice for same host:port', async () => {
  const { server, port } = await startMockNmea0183Server();
  const orch = new Orchestrator({
    udpBindAddress: '127.0.0.1',
    udpPort: 0,
    enable: {
      'udp-timezero': false,
      'tcp-nmea0183': true,
      'tcp-n2k-yd-raw': false,
      'tcp-n2k-actisense': false,
    },
    probeTimeoutMs: 500,
    probeBudgetMs: 1000,
    probeTargets: [],
  });
  await orch.start(
    () => {},
    () => {},
  );

  const first = await orch.tryAttach('127.0.0.1', port, 'tcp-nmea0183', 1000);
  assert.equal(first.ok, true);
  const second = await orch.tryAttach('127.0.0.1', port, 'tcp-nmea0183', 1000);
  assert.equal(second.ok, true);
  // Same adapter id, idempotent.
  assert.equal(second.status?.id, first.status?.id);

  await orch.stop();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

test('detach removes the adapter from statusSnapshot', async () => {
  const { server, port } = await startMockNmea0183Server();
  const orch = new Orchestrator({
    udpBindAddress: '127.0.0.1',
    udpPort: 0,
    enable: {
      'udp-timezero': false,
      'tcp-nmea0183': true,
      'tcp-n2k-yd-raw': false,
      'tcp-n2k-actisense': false,
    },
    probeTimeoutMs: 500,
    probeBudgetMs: 1000,
    probeTargets: [],
  });
  await orch.start(
    () => {},
    () => {},
  );
  const r = await orch.tryAttach('127.0.0.1', port, 'tcp-nmea0183', 1000);
  assert.ok(r.ok);
  assert.equal(orch.statusSnapshot().adapters.length, 1);

  const detached = await orch.detach(r.status!.id);
  assert.equal(detached, true);
  assert.equal(orch.statusSnapshot().adapters.length, 0);

  await orch.stop();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

test('statusSnapshot exposes lastAutoProbe timestamp after start', async () => {
  const orch = new Orchestrator({
    udpBindAddress: '127.0.0.1',
    udpPort: 0,
    enable: {
      'udp-timezero': false,
      'tcp-nmea0183': true,
      'tcp-n2k-yd-raw': false,
      'tcp-n2k-actisense': false,
    },
    probeTimeoutMs: 200,
    probeBudgetMs: 500,
    probeTargets: ['127.0.0.1'],
  });
  await orch.start(
    () => {},
    () => {},
  );
  const snap = orch.statusSnapshot();
  assert.ok(snap.lastAutoProbe, 'lastAutoProbe should be set');
  await orch.stop();
});
