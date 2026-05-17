/**
 * N2K PGN decoder tests. Each fixture exercises one PGN with a hand-built
 * byte buffer where the expected Signal K output is known from the spec.
 *
 * Engine instance 0 → "port", 1 → "starboard"; battery instance 0 → "house";
 * tank instance retained as numeric (matches the dashboard convention).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { n2kToSignalK, SUPPORTED_PGNS } from '../src/n2kToSignalK.js';

function bytes(...vals: number[]): Uint8Array {
  return new Uint8Array(vals);
}

function findValue(result: ReturnType<typeof n2kToSignalK>, path: string): number | null {
  const v = result.find((r) => r.path === path);
  return v ? (v.value as number) : null;
}

test('PGN 127488 — engine RPM port engine (instance 0)', () => {
  // Instance 0, RPM = 1800 (0.25 LSB → raw 7200 = 0x1C20 little-endian: 20 1C)
  // Boost pressure ignored (not in our mapping).
  const data = bytes(0x00, 0x20, 0x1c, 0xff, 0xff, 0xff, 0xff, 0xff);
  const result = n2kToSignalK(127488, data);
  const hz = findValue(result, 'propulsion.port.revolutions');
  assert.ok(hz !== null, 'rev/s should be emitted');
  // 1800 RPM ÷ 60 = 30 rev/s
  assert.equal(Math.round(hz! * 1000) / 1000, 30);
});

test('PGN 127488 — engine RPM starboard (instance 1)', () => {
  const data = bytes(0x01, 0x40, 0x0e, 0xff, 0xff, 0xff, 0xff, 0xff);
  const result = n2kToSignalK(127488, data);
  // raw 0x0E40 = 3648; ÷4 = 912 RPM; ÷60 = 15.2 rev/s
  const hz = findValue(result, 'propulsion.starboard.revolutions');
  assert.ok(hz !== null);
  assert.equal(Math.round(hz! * 10) / 10, 15.2);
});

test('PGN 127488 — null engine speed sentinel produces no value', () => {
  const data = bytes(0x00, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff);
  const result = n2kToSignalK(127488, data);
  assert.deepEqual(result, []);
});

test('PGN 127489 — coolant temperature port (Kelvin, ×0.01)', () => {
  // Instance 0; oil pressure null; oil temp null; coolant temp = 363.15 K (90 °C)
  // raw 36315 = 0x8DDB → little endian DB 8D
  const data = bytes(
    0x00, // instance
    0xff, 0xff, // oil pressure null
    0xff, 0xff, // oil temp null
    0xdb, 0x8d, // coolant 36315
    0xff, 0xff, // alternator V null
    0xff, 0xff, // fuel rate null
    0xff, 0xff, 0xff, 0xff, // hours null
  );
  const result = n2kToSignalK(127489, data);
  const k = findValue(result, 'propulsion.port.coolantTemperature');
  assert.ok(k !== null);
  assert.equal(Math.round(k! * 100) / 100, 363.15);
});

test('PGN 127489 — alternator voltage starboard (×0.01 V)', () => {
  // Instance 1; alternator V = 14.20 V = 1420 = 0x058C → 8C 05
  const data = bytes(
    0x01, // instance
    0xff, 0xff,
    0xff, 0xff,
    0xff, 0xff,
    0x8c, 0x05, // alternator 14.20 V
    0xff, 0xff,
    0xff, 0xff, 0xff, 0xff,
  );
  const result = n2kToSignalK(127489, data);
  const v = findValue(result, 'propulsion.starboard.alternatorVoltage');
  assert.ok(v !== null);
  assert.equal(Math.round(v! * 100) / 100, 14.2);
});

test('PGN 127505 — fuel tank 0, 75% level', () => {
  // instAndType: instance 0, type 0 (fuel) → 0x00
  // level = 75 % × 250 = 18750 = 0x493E → 3E 49
  // capacity = 200 L × 10 = 2000 = 0x000007D0 → D0 07 00 00
  const data = bytes(0x00, 0x3e, 0x49, 0xd0, 0x07, 0x00, 0x00, 0xff);
  const result = n2kToSignalK(127505, data);
  const level = findValue(result, 'tanks.fuel.0.currentLevel');
  const cap = findValue(result, 'tanks.fuel.0.capacity');
  assert.ok(level !== null, 'level should be emitted');
  assert.equal(Math.round(level! * 100) / 100, 0.75);
  assert.ok(cap !== null, 'capacity should be emitted');
  // 2000 × 0.1 L = 200 L = 0.2 m³
  assert.equal(Math.round(cap! * 1000) / 1000, 0.2);
});

test('PGN 127505 — freshwater tank 1 (instance 1, type 1)', () => {
  // instAndType: instance 1, type 1 → 0x11
  // level 50% raw = 12500 = 0x30D4 → D4 30
  const data = bytes(0x11, 0xd4, 0x30, 0xff, 0xff, 0xff, 0xff, 0xff);
  const result = n2kToSignalK(127505, data);
  const level = findValue(result, 'tanks.freshWater.1.currentLevel');
  assert.ok(level !== null);
  assert.equal(Math.round(level! * 100) / 100, 0.5);
});

test('PGN 127505 — unknown tank type is dropped', () => {
  // type 7 is undefined in our table.
  const data = bytes(0x70, 0xd4, 0x30, 0xff, 0xff, 0xff, 0xff, 0xff);
  const result = n2kToSignalK(127505, data);
  assert.deepEqual(result, []);
});

test('PGN 127508 — house battery 12.6 V, -5 A draw', () => {
  // instance 0 = house; voltage 12.60 = 1260 = 0x04EC → EC 04
  // current -5.0 = -50 = 0xFFCE → CE FF (two's complement)
  // temp null
  const data = bytes(0x00, 0xec, 0x04, 0xce, 0xff, 0xff, 0xff, 0xff);
  const result = n2kToSignalK(127508, data);
  const v = findValue(result, 'electrical.batteries.house.voltage');
  const a = findValue(result, 'electrical.batteries.house.current');
  assert.ok(v !== null);
  assert.equal(Math.round(v! * 100) / 100, 12.6);
  assert.ok(a !== null);
  assert.equal(Math.round(a! * 10) / 10, -5);
});

test('PGN 127506 — state of charge 78%', () => {
  // SID, instance 0 = house, dcType, SoC 78, SoH 95
  const data = bytes(0x00, 0x00, 0x00, 78, 95, 0xff, 0xff, 0xff, 0xff);
  const result = n2kToSignalK(127506, data);
  const soc = findValue(result, 'electrical.batteries.house.capacity.stateOfCharge');
  const soh = findValue(result, 'electrical.batteries.house.capacity.stateOfHealth');
  assert.ok(soc !== null);
  assert.equal(Math.round(soc! * 100) / 100, 0.78);
  assert.ok(soh !== null);
  assert.equal(Math.round(soh! * 100) / 100, 0.95);
});

test('PGN 127245 — rudder angle 0.1 rad', () => {
  // angle order ignored; position = 0.1 rad = 1000 = 0x03E8 → E8 03
  const data = bytes(0x00, 0x00, 0xff, 0xff, 0xe8, 0x03, 0xff, 0xff);
  const result = n2kToSignalK(127245, data);
  const ang = findValue(result, 'steering.rudderAngle');
  assert.ok(ang !== null);
  assert.equal(Math.round(ang! * 1000) / 1000, 0.1);
});

test('Unknown PGN returns empty', () => {
  const data = bytes(0x00, 0x00, 0x00, 0x00);
  assert.deepEqual(n2kToSignalK(999999, data), []);
});

test('Truncated payload returns empty without throwing', () => {
  assert.deepEqual(n2kToSignalK(127488, bytes(0x00)), []);
  assert.deepEqual(n2kToSignalK(127505, bytes(0x00, 0x00)), []);
});

test('SUPPORTED_PGNS lists exactly the six we decode', () => {
  assert.deepEqual(
    [...SUPPORTED_PGNS].sort((a, b) => a - b),
    [127245, 127488, 127489, 127505, 127506, 127508],
  );
});
