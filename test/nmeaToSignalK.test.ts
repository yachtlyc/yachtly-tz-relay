import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  nmeaToSignalK,
  parseNmeaFields,
  SUPPORTED_SENTENCES,
} from '../src/nmeaToSignalK.ts';
import { SK } from '../src/paths.ts';

const close = (actual: number, expected: number, tol = 1e-6) => {
  assert.ok(
    Math.abs(actual - expected) < tol,
    `expected ${expected} ± ${tol}, got ${actual}`,
  );
};

test('parseNmeaFields strips $ and validates checksum', () => {
  const ok = parseNmeaFields('$GPRMC,123519,A,4807.038,N,01131.000,E,022.4,084.4,230394,003.1,W*6A');
  assert.ok(ok, 'should accept valid checksum');
  assert.equal(ok![0], 'GPRMC');

  const badCsum = parseNmeaFields('$GPRMC,123519,A,4807.038,N,01131.000,E,022.4,084.4,230394,003.1,W*FF');
  assert.equal(badCsum, null, 'should reject bad checksum');

  const noCsum = parseNmeaFields('$GPRMC,123519,A,4807.038,N,01131.000,E');
  assert.ok(noCsum, 'should accept sentence without checksum');
});

test('RMC produces lat/lon/SOG/COG with correct units', () => {
  const v = nmeaToSignalK('$GPRMC,123519,A,4807.038,N,01131.000,E,022.4,084.4,230394,003.1,W*6A');
  const byPath = Object.fromEntries(v.map((x) => [x.path, x.value as number]));

  // 48° 07.038' N = 48 + 7.038/60 ≈ 48.1173
  close(byPath[SK.positionLat], 48 + 7.038 / 60, 1e-4);
  // 11° 31.000' E ≈ 11.5167
  close(byPath[SK.positionLon], 11 + 31.0 / 60, 1e-4);
  // SOG 22.4 kn → m/s
  close(byPath[SK.sog], 22.4 * (1852 / 3600), 1e-4);
  // COG 84.4° → rad
  close(byPath[SK.cog], (84.4 * Math.PI) / 180, 1e-6);
});

test('RMC with status=V (void) returns nothing', () => {
  const v = nmeaToSignalK('$GPRMC,123519,V,4807.038,N,01131.000,E,022.4,084.4,230394,003.1,W*7D');
  assert.equal(v.length, 0);
});

test('RMC with southern/western hemisphere applies sign', () => {
  // Checksums omitted on these fixtures — parser accepts sentences without
  // them. Test #1 above covers the checksum-validation path explicitly.
  const v = nmeaToSignalK('$GPRMC,123519,A,3340.000,S,07045.000,W,000.0,000.0,010122,,,A');
  const byPath = Object.fromEntries(v.map((x) => [x.path, x.value as number]));
  close(byPath[SK.positionLat], -(33 + 40 / 60), 1e-4);
  close(byPath[SK.positionLon], -(70 + 45 / 60), 1e-4);
});

test('VTG produces SOG and COG', () => {
  const v = nmeaToSignalK('$GPVTG,054.7,T,034.4,M,005.5,N,010.2,K,A');
  const byPath = Object.fromEntries(v.map((x) => [x.path, x.value as number]));
  close(byPath[SK.cog], (54.7 * Math.PI) / 180, 1e-6);
  close(byPath[SK.sog], 5.5 * (1852 / 3600), 1e-4);
});

test('HDT produces heading in radians', () => {
  const v = nmeaToSignalK('$HEHDT,124.5,T');
  assert.equal(v.length, 1);
  assert.equal(v[0].path, SK.headingTrue);
  close(v[0].value as number, (124.5 * Math.PI) / 180, 1e-6);
});

test('HDM produces magnetic heading', () => {
  const v = nmeaToSignalK('$HCHDM,235.7,M');
  assert.equal(v.length, 1);
  assert.equal(v[0].path, SK.headingMagnetic);
});

test('DBT prefers metres over feet when both present', () => {
  const v = nmeaToSignalK('$SDDBT,032.8,f,010.0,M,005.4,F');
  assert.equal(v.length, 1);
  assert.equal(v[0].path, SK.depthBelowTransducer);
  close(v[0].value as number, 10.0, 1e-6);
});

test('DPT produces depth in metres', () => {
  const v = nmeaToSignalK('$SDDPT,12.5,0.0,100.0');
  assert.equal(v.length, 1);
  close(v[0].value as number, 12.5, 1e-6);
});

test('MWV apparent maps angle to -pi..pi and speed to m/s', () => {
  const v = nmeaToSignalK('$IIMWV,090.0,R,010.0,N,A');
  const byPath = Object.fromEntries(v.map((x) => [x.path, x.value as number]));
  close(byPath[SK.windAngleApparent], (90 * Math.PI) / 180, 1e-6);
  close(byPath[SK.windSpeedApparent], 10 * (1852 / 3600), 1e-4);

  // 270 deg (port) — should become -90 deg → -pi/2
  const v2 = nmeaToSignalK('$IIMWV,270.0,R,010.0,N,A');
  const byPath2 = Object.fromEntries(v2.map((x) => [x.path, x.value as number]));
  close(byPath2[SK.windAngleApparent], -Math.PI / 2, 1e-6);
});

test('MTW converts Celsius to Kelvin', () => {
  const v = nmeaToSignalK('$YXMTW,18.5,C');
  assert.equal(v[0].path, SK.waterTemperature);
  close(v[0].value as number, 18.5 + 273.15, 1e-6);
});

test('MDA reads pressure in bars and converts to Pa', () => {
  const v = nmeaToSignalK('$IIMDA,30.10,I,1.0193,B,22.5,C,18.0,C,55.0,,,,,,,,,,,');
  const byPath = Object.fromEntries(v.map((x) => [x.path, x.value as number]));
  close(byPath[SK.outsidePressure], 1.0193 * 100000, 1e-2);
  close(byPath[SK.outsideTemperature], 22.5 + 273.15, 1e-6);
  close(byPath[SK.waterTemperature], 18.0 + 273.15, 1e-6);
});

test('VLW emits trip and total log in metres', () => {
  const v = nmeaToSignalK('$VWVLW,1234.5,N,12.3,N');
  const byPath = Object.fromEntries(v.map((x) => [x.path, x.value as number]));
  close(byPath[SK.totalLog], 1234.5 * 1852, 1e-3);
  close(byPath[SK.tripLog], 12.3 * 1852, 1e-3);
});

test('Unknown sentence returns empty array, never throws', () => {
  assert.deepEqual(nmeaToSignalK('$XXFOO,1,2,3*00'), []);
  assert.deepEqual(nmeaToSignalK('garbage'), []);
  assert.deepEqual(nmeaToSignalK(''), []);
  assert.deepEqual(nmeaToSignalK('$$$'), []);
});

test('SUPPORTED_SENTENCES list is non-empty and includes the core nav set', () => {
  for (const tag of ['RMC', 'GGA', 'VTG', 'HDT', 'DBT', 'MWV']) {
    assert.ok(SUPPORTED_SENTENCES.includes(tag), `missing handler for ${tag}`);
  }
});
