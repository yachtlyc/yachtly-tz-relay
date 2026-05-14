/**
 * NMEA 0183 → Signal K translator.
 *
 * Parses a single NMEA sentence and returns zero or more `{path, value}` pairs
 * suitable for emission inside a Signal K delta `update.values` array.
 *
 * Units follow Signal K conventions:
 *   - Angles: radians
 *   - Speeds: m/s
 *   - Temperatures: Kelvin
 *   - Pressures: Pa
 *   - Lat/lon: signed decimal degrees
 *   - Depths / distances: metres
 *
 * Read-only by design: the function takes a string and returns data; it has no
 * side effects and never throws on malformed input.
 */

import { SK, type SignalKPath } from './paths.js';

export interface SignalKValue {
  path: SignalKPath;
  value: number | string | boolean;
}

const KN_TO_MS = 1852 / 3600;          // ≈ 0.514444
const NM_TO_M = 1852;
const FT_TO_M = 0.3048;
const KMH_TO_MS = 1000 / 3600;
const DEG_TO_RAD = Math.PI / 180;
const C_TO_K = 273.15;
const BAR_TO_PA = 100_000;
const INHG_TO_PA = 3386.389;

const num = (s: string | undefined): number | null => {
  if (s === undefined || s === '') return null;
  const n = Number.parseFloat(s);
  return Number.isFinite(n) ? n : null;
};

const ddmmToDeg = (raw: string | undefined, hemi: string | undefined): number | null => {
  const v = num(raw);
  if (v === null) return null;
  // Format: DDMM.mmmm or DDDMM.mmmm — the degrees are everything left of the last
  // two integer digits before the decimal point.
  const deg = Math.floor(v / 100);
  const min = v - deg * 100;
  let result = deg + min / 60;
  if (hemi === 'S' || hemi === 'W') result = -result;
  if (!Number.isFinite(result)) return null;
  return result;
};

/**
 * Validate the XOR checksum on an NMEA sentence and strip leading `$` /
 * trailing `*HH\r\n`. Returns the comma-separated field list, or null if the
 * sentence is malformed or the checksum is wrong.
 */
export function parseNmeaFields(sentence: string): string[] | null {
  if (!sentence) return null;
  const trimmed = sentence.trim();
  if (trimmed.length < 7) return null;
  if (trimmed[0] !== '$' && trimmed[0] !== '!') return null;

  const starIdx = trimmed.lastIndexOf('*');
  let body: string;
  if (starIdx === -1) {
    // No checksum — accept anyway (some bridges drop them).
    body = trimmed.slice(1);
  } else {
    body = trimmed.slice(1, starIdx);
    const expected = trimmed.slice(starIdx + 1).trim().toUpperCase();
    let xor = 0;
    for (let i = 0; i < body.length; i++) xor ^= body.charCodeAt(i);
    const computed = xor.toString(16).toUpperCase().padStart(2, '0');
    if (computed !== expected) return null;
  }

  return body.split(',');
}

interface Handler {
  (fields: string[]): SignalKValue[];
}

const HANDLERS: Record<string, Handler> = {
  // $--RMC,time,status,lat,N/S,lon,E/W,sog_kn,cog_true,date,magVar,magVar_E/W,mode*hh
  RMC: (f) => {
    if (f[2] !== 'A') return [];
    const lat = ddmmToDeg(f[3], f[4]);
    const lon = ddmmToDeg(f[5], f[6]);
    const sogKn = num(f[7]);
    const cogDeg = num(f[8]);
    const out: SignalKValue[] = [];
    if (lat !== null) out.push({ path: SK.positionLat, value: lat });
    if (lon !== null) out.push({ path: SK.positionLon, value: lon });
    if (sogKn !== null) out.push({ path: SK.sog, value: sogKn * KN_TO_MS });
    if (cogDeg !== null) out.push({ path: SK.cog, value: cogDeg * DEG_TO_RAD });
    return out;
  },

  // $--GGA,time,lat,N/S,lon,E/W,fix,nsat,hdop,alt,M,geoid,M,dgpsAge,dgpsId*hh
  GGA: (f) => {
    const fix = Number.parseInt(f[6] ?? '0', 10);
    if (!Number.isFinite(fix) || fix < 1) return [];
    const lat = ddmmToDeg(f[2], f[3]);
    const lon = ddmmToDeg(f[4], f[5]);
    const out: SignalKValue[] = [];
    if (lat !== null) out.push({ path: SK.positionLat, value: lat });
    if (lon !== null) out.push({ path: SK.positionLon, value: lon });
    return out;
  },

  // $--VTG,cogTrue,T,cogMag,M,sogKn,N,sogKph,K,mode*hh
  VTG: (f) => {
    const cogT = num(f[1]);
    const sogKn = num(f[5]);
    const sogKph = num(f[7]);
    const out: SignalKValue[] = [];
    if (cogT !== null) out.push({ path: SK.cog, value: cogT * DEG_TO_RAD });
    if (sogKn !== null) out.push({ path: SK.sog, value: sogKn * KN_TO_MS });
    else if (sogKph !== null) out.push({ path: SK.sog, value: sogKph * KMH_TO_MS });
    return out;
  },

  // $--HDT,heading,T*hh
  HDT: (f) => {
    const h = num(f[1]);
    return h !== null ? [{ path: SK.headingTrue, value: h * DEG_TO_RAD }] : [];
  },

  // $--HDM,heading,M*hh
  HDM: (f) => {
    const h = num(f[1]);
    return h !== null ? [{ path: SK.headingMagnetic, value: h * DEG_TO_RAD }] : [];
  },

  // $--HDG,headingMag,deviation,E/W,variation,E/W*hh
  HDG: (f) => {
    const h = num(f[1]);
    return h !== null ? [{ path: SK.headingMagnetic, value: h * DEG_TO_RAD }] : [];
  },

  // $--DBT,depthFt,f,depthM,M,depthFathoms,F*hh
  DBT: (f) => {
    const dM = num(f[3]);
    if (dM !== null) return [{ path: SK.depthBelowTransducer, value: dM }];
    const dFt = num(f[1]);
    if (dFt !== null) return [{ path: SK.depthBelowTransducer, value: dFt * FT_TO_M }];
    return [];
  },

  // $--DPT,depthM,offsetM,maxRangeM*hh
  DPT: (f) => {
    const d = num(f[1]);
    return d !== null ? [{ path: SK.depthBelowTransducer, value: d }] : [];
  },

  // $--MWV,angle,reference(R/T),speed,unit(N/M/K),status(A/V)*hh
  MWV: (f) => {
    if (f[5] && f[5] !== 'A') return [];
    const angle = num(f[1]);
    const speed = num(f[3]);
    const ref = f[2];
    const unit = f[4];
    const out: SignalKValue[] = [];

    let speedMs: number | null = null;
    if (speed !== null) {
      if (unit === 'N') speedMs = speed * KN_TO_MS;
      else if (unit === 'M') speedMs = speed;
      else if (unit === 'K') speedMs = speed * KMH_TO_MS;
    }

    if (ref === 'R') {
      if (angle !== null) {
        // NMEA gives 0-359 clockwise from bow; Signal K wants -pi..pi (port negative).
        const a = angle > 180 ? angle - 360 : angle;
        out.push({ path: SK.windAngleApparent, value: a * DEG_TO_RAD });
      }
      if (speedMs !== null) out.push({ path: SK.windSpeedApparent, value: speedMs });
    } else if (ref === 'T') {
      if (angle !== null) {
        const a = angle > 180 ? angle - 360 : angle;
        out.push({ path: SK.windAngleTrue, value: a * DEG_TO_RAD });
      }
      if (speedMs !== null) out.push({ path: SK.windSpeedTrue, value: speedMs });
    }
    return out;
  },

  // $--MWD,dirTrue,T,dirMag,M,speedKn,N,speedMs,M*hh
  MWD: (f) => {
    const dirT = num(f[1]);
    const speedKn = num(f[5]);
    const speedMs = num(f[7]);
    const out: SignalKValue[] = [];
    if (dirT !== null) out.push({ path: SK.windDirectionTrue, value: dirT * DEG_TO_RAD });
    if (speedMs !== null) out.push({ path: SK.windSpeedTrue, value: speedMs });
    else if (speedKn !== null) out.push({ path: SK.windSpeedTrue, value: speedKn * KN_TO_MS });
    return out;
  },

  // $--MDA,pInHg,I,pBar,B,tempAir_C,C,tempWater_C,C,humRel,humAbs,dewpoint,C,
  //       windDirT,T,windDirM,M,windSpeedKn,N,windSpeedMs,M*hh
  MDA: (f) => {
    const out: SignalKValue[] = [];
    const pInHg = num(f[1]);
    const pBar = num(f[3]);
    if (pBar !== null) out.push({ path: SK.outsidePressure, value: pBar * BAR_TO_PA });
    else if (pInHg !== null) out.push({ path: SK.outsidePressure, value: pInHg * INHG_TO_PA });

    const airC = num(f[5]);
    if (airC !== null) out.push({ path: SK.outsideTemperature, value: airC + C_TO_K });

    const waterC = num(f[7]);
    if (waterC !== null) out.push({ path: SK.waterTemperature, value: waterC + C_TO_K });

    const humRel = num(f[9]);
    if (humRel !== null) out.push({ path: SK.outsideHumidity, value: humRel / 100 });

    const windDirT = num(f[13]);
    if (windDirT !== null) out.push({ path: SK.windDirectionTrue, value: windDirT * DEG_TO_RAD });

    const windSpKn = num(f[17]);
    const windSpMs = num(f[19]);
    if (windSpMs !== null) out.push({ path: SK.windSpeedTrue, value: windSpMs });
    else if (windSpKn !== null) out.push({ path: SK.windSpeedTrue, value: windSpKn * KN_TO_MS });

    return out;
  },

  // $--MTW,tempC,C*hh
  MTW: (f) => {
    const t = num(f[1]);
    return t !== null ? [{ path: SK.waterTemperature, value: t + C_TO_K }] : [];
  },

  // $--VLW,totalNm,N,tripNm,N*hh   (newer 4-arg form omitted here)
  VLW: (f) => {
    const total = num(f[1]);
    const trip = num(f[3]);
    const out: SignalKValue[] = [];
    if (total !== null) out.push({ path: SK.totalLog, value: total * NM_TO_M });
    if (trip !== null) out.push({ path: SK.tripLog, value: trip * NM_TO_M });
    return out;
  },

  // $--VHW,headingT,T,headingM,M,speedKn,N,speedKmh,K*hh
  VHW: (f) => {
    const out: SignalKValue[] = [];
    const hT = num(f[1]);
    const hM = num(f[3]);
    const stwKn = num(f[5]);
    const stwKph = num(f[7]);
    if (hT !== null) out.push({ path: SK.headingTrue, value: hT * DEG_TO_RAD });
    if (hM !== null) out.push({ path: SK.headingMagnetic, value: hM * DEG_TO_RAD });
    if (stwKn !== null) out.push({ path: SK.speedThroughWater, value: stwKn * KN_TO_MS });
    else if (stwKph !== null) out.push({ path: SK.speedThroughWater, value: stwKph * KMH_TO_MS });
    return out;
  },
};

/**
 * Translate a single NMEA sentence to zero or more Signal K values.
 * Returns an empty array on unknown or malformed sentences — never throws.
 */
export function nmeaToSignalK(sentence: string): SignalKValue[] {
  const fields = parseNmeaFields(sentence);
  if (!fields || fields.length === 0) return [];
  // First field is "GPRMC", "HEHDT" etc. — talker (2) + sentence id (3).
  const tag = fields[0];
  if (tag.length < 5) return [];
  const sentenceId = tag.slice(2);
  const handler = HANDLERS[sentenceId];
  if (!handler) return [];
  try {
    return handler(fields);
  } catch {
    // SECURITY: never propagate parser errors back to the UDP loop.
    return [];
  }
}

export const SUPPORTED_SENTENCES = Object.keys(HANDLERS);
