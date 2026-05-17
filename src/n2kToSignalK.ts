/**
 * NMEA 2000 PGN → Signal K translator (hand-rolled, focused).
 *
 * Decodes the six PGNs that drive the dashboard's Engine, Tanks &
 * Electrical, and Steering tabs:
 *
 *   127245 — Rudder
 *   127488 — Engine Parameters, Rapid Update      (single-frame, 8 bytes)
 *   127489 — Engine Parameters, Dynamic           (Fast-Packet, 26 bytes)
 *   127505 — Fluid Level (tanks)                  (single-frame, 8 bytes)
 *   127506 — DC Detailed Status (battery SoC)     (single-frame, 9 bytes)
 *   127508 — Battery Status (V/A/temp)            (single-frame, 8 bytes)
 *
 * Inputs are already reassembled payloads — both YDWG RAW and Actisense
 * ASCII gateways perform Fast-Packet reassembly upstream and emit the
 * full multi-byte message in a single line, so this decoder works on
 * complete byte arrays rather than raw CAN frames.
 *
 * Units follow Signal K conventions: rad/s for RPM, K for temperatures,
 * Pa for pressures, ratios (0..1) for percentages, m³ for tank capacities.
 *
 * Read-only by design: pure functions, no side effects, never throws on
 * malformed input.
 */

import type { SignalKValue } from './nmeaToSignalK.js';

const RPM_SCALE = 0.25;
const PRESSURE_HPA_TO_PA = 100;
const TEMP_SCALE = 0.01;          // K per LSB
const VOLT_SCALE = 0.01;          // V per LSB
const CURRENT_SCALE = 0.1;        // A per LSB
const LEVEL_SCALE = 0.004;        // % per LSB (level / 0.004 = %)
const CAPACITY_SCALE = 0.1;       // L per LSB (capacity / 10 = L, then ×0.001 = m³)
const ANGLE_SCALE = 0.0001;       // rad per LSB
const FUEL_RATE_SCALE = 0.1;      // L/h per LSB
const HOURS_SECONDS_PER_LSB = 1;  // engine hours stored in seconds directly

/** N2K "not available" sentinels for unsigned ints. */
const U8_NA = 0xff;
const U16_NA = 0xffff;
const U32_NA = 0xffffffff;
const I16_NA = -0x8000;

function u8(data: Uint8Array, offset: number): number | null {
  if (offset >= data.length) return null;
  const v = data[offset];
  return v === U8_NA ? null : v;
}

function u16le(data: Uint8Array, offset: number): number | null {
  if (offset + 1 >= data.length) return null;
  const v = data[offset] | (data[offset + 1] << 8);
  return v === U16_NA ? null : v;
}

function i16le(data: Uint8Array, offset: number): number | null {
  if (offset + 1 >= data.length) return null;
  const raw = data[offset] | (data[offset + 1] << 8);
  const v = raw >= 0x8000 ? raw - 0x10000 : raw;
  return v === I16_NA ? null : v;
}

function u32le(data: Uint8Array, offset: number): number | null {
  if (offset + 3 >= data.length) return null;
  const v =
    data[offset] |
    (data[offset + 1] << 8) |
    (data[offset + 2] << 16) |
    // Bitwise-or can return negative for the top bit; force unsigned.
    (data[offset + 3] * 0x1000000);
  return v === U32_NA ? null : v;
}

function engineLabel(instance: number): string {
  if (instance === 0) return 'port';
  if (instance === 1) return 'starboard';
  return `${instance}`;
}

function tankTypeLabel(type: number): string | null {
  switch (type) {
    case 0: return 'fuel';
    case 1: return 'freshWater';
    case 2: return 'wasteWater';
    case 3: return 'liveWell';
    case 4: return 'oil';
    case 5: return 'blackWater';
    default: return null;
  }
}

function batteryLabel(instance: number): string {
  // Convention: instance 0 is the house bank on most boats; further
  // instances retain the numeric id so the dashboard can address them.
  if (instance === 0) return 'house';
  if (instance === 1) return 'starter';
  return `${instance}`;
}

// ── PGN handlers ─────────────────────────────────────────────────────────

/** PGN 127488 — Engine Parameters, Rapid Update (8 bytes). */
function pgn127488(data: Uint8Array): SignalKValue[] {
  if (data.length < 4) return [];
  const inst = data[0];
  const rpmRaw = u16le(data, 1);
  const boostRaw = u16le(data, 3);
  const out: SignalKValue[] = [];
  const eng = engineLabel(inst);
  if (rpmRaw !== null) {
    // Signal K convention for `propulsion.{instance}.revolutions` is Hz
    // (rev/s); the dashboard's `revsPerSecondToRPM` does the inverse.
    out.push({ path: `propulsion.${eng}.revolutions`, value: (rpmRaw * RPM_SCALE) / 60 });
  }
  if (boostRaw !== null) {
    out.push({ path: `propulsion.${eng}.boostPressure`, value: boostRaw * PRESSURE_HPA_TO_PA });
  }
  return out;
}

/** PGN 127489 — Engine Parameters, Dynamic (26 bytes, Fast-Packet reassembled). */
function pgn127489(data: Uint8Array): SignalKValue[] {
  if (data.length < 14) return [];
  const inst = data[0];
  const eng = engineLabel(inst);
  const out: SignalKValue[] = [];

  const oilPressureRaw = u16le(data, 1);   // hPa
  if (oilPressureRaw !== null) {
    out.push({ path: `propulsion.${eng}.oilPressure`, value: oilPressureRaw * PRESSURE_HPA_TO_PA });
  }

  const oilTempRaw = u16le(data, 3);       // K × 0.1 (note: PGN spec says 0.01 K but real-world gateways often emit 0.1; we honour the spec)
  if (oilTempRaw !== null) {
    out.push({ path: `propulsion.${eng}.oilTemperature`, value: oilTempRaw * TEMP_SCALE });
  }

  const coolantTempRaw = u16le(data, 5);   // K × 0.01
  if (coolantTempRaw !== null) {
    out.push({ path: `propulsion.${eng}.coolantTemperature`, value: coolantTempRaw * TEMP_SCALE });
  }

  const altVoltRaw = i16le(data, 7);       // V × 0.01
  if (altVoltRaw !== null) {
    out.push({ path: `propulsion.${eng}.alternatorVoltage`, value: altVoltRaw * VOLT_SCALE });
  }

  const fuelRateRaw = i16le(data, 9);      // L/h × 0.1
  if (fuelRateRaw !== null) {
    out.push({ path: `propulsion.${eng}.fuel.rate`, value: (fuelRateRaw * FUEL_RATE_SCALE) / 3600 / 1000 });
    // Signal K wants m³/s; convert L/h → m³/s via /3.6e6.
  }

  const engineHoursRaw = u32le(data, 11);  // seconds
  if (engineHoursRaw !== null) {
    out.push({ path: `propulsion.${eng}.runTime`, value: engineHoursRaw * HOURS_SECONDS_PER_LSB });
  }

  return out;
}

/** PGN 127505 — Fluid Level (8 bytes). */
function pgn127505(data: Uint8Array): SignalKValue[] {
  if (data.length < 7) return [];
  const instAndType = data[0];
  const instance = instAndType & 0x0f;
  const type = (instAndType >> 4) & 0x0f;
  const label = tankTypeLabel(type);
  if (!label) return [];

  const levelRaw = i16le(data, 1);
  const capacityRaw = u32le(data, 3);
  const out: SignalKValue[] = [];

  if (levelRaw !== null) {
    // Signal K wants a ratio (0..1), not a percentage.
    const pct = levelRaw * LEVEL_SCALE;
    out.push({ path: `tanks.${label}.${instance}.currentLevel`, value: pct / 100 });
  }
  if (capacityRaw !== null) {
    // capacity is in 0.1 L; convert to m³ (×1e-4).
    out.push({ path: `tanks.${label}.${instance}.capacity`, value: capacityRaw * CAPACITY_SCALE * 1e-3 });
  }
  return out;
}

/** PGN 127508 — Battery Status (8 bytes). */
function pgn127508(data: Uint8Array): SignalKValue[] {
  if (data.length < 7) return [];
  const inst = data[0];
  const label = batteryLabel(inst);
  const voltRaw = i16le(data, 1);
  const currRaw = i16le(data, 3);
  const tempRaw = u16le(data, 5);
  const out: SignalKValue[] = [];
  if (voltRaw !== null) {
    out.push({ path: `electrical.batteries.${label}.voltage`, value: voltRaw * VOLT_SCALE });
  }
  if (currRaw !== null) {
    out.push({ path: `electrical.batteries.${label}.current`, value: currRaw * CURRENT_SCALE });
  }
  if (tempRaw !== null) {
    out.push({ path: `electrical.batteries.${label}.temperature`, value: tempRaw * TEMP_SCALE });
  }
  return out;
}

/** PGN 127506 — DC Detailed Status (9 bytes). */
function pgn127506(data: Uint8Array): SignalKValue[] {
  if (data.length < 5) return [];
  const inst = data[1];
  const label = batteryLabel(inst);
  const socPct = u8(data, 3);  // %
  const sohPct = u8(data, 4);  // %
  const out: SignalKValue[] = [];
  if (socPct !== null) {
    out.push({ path: `electrical.batteries.${label}.capacity.stateOfCharge`, value: socPct / 100 });
  }
  if (sohPct !== null) {
    out.push({ path: `electrical.batteries.${label}.capacity.stateOfHealth`, value: sohPct / 100 });
  }
  return out;
}

/** PGN 127245 — Rudder (8 bytes). */
function pgn127245(data: Uint8Array): SignalKValue[] {
  if (data.length < 6) return [];
  // Byte 0: instance, byte 1: direction (4 bits) + reserved, bytes 2-3: angle order, bytes 4-5: position.
  const posRaw = i16le(data, 4);
  if (posRaw === null) return [];
  return [{ path: 'steering.rudderAngle', value: posRaw * ANGLE_SCALE }];
}

type Handler = (data: Uint8Array) => SignalKValue[];

const HANDLERS: Record<number, Handler> = {
  127245: pgn127245,
  127488: pgn127488,
  127489: pgn127489,
  127505: pgn127505,
  127506: pgn127506,
  127508: pgn127508,
};

/**
 * Decode a single reassembled N2K message into zero or more Signal K
 * values. Unknown PGNs and malformed data return an empty array — never
 * throws.
 */
export function n2kToSignalK(pgn: number, data: Uint8Array): SignalKValue[] {
  const handler = HANDLERS[pgn];
  if (!handler) return [];
  try {
    return handler(data);
  } catch {
    return [];
  }
}

export const SUPPORTED_PGNS = Object.keys(HANDLERS).map(Number);
