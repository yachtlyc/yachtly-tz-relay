/**
 * YDWG RAW frame parser tests — exercise the CAN-ID → (PGN, source)
 * derivation and the hex-byte payload extraction independently of the
 * TCP socket plumbing.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseYDRawLine } from '../src/adapters/tcpN2KYDRaw.js';

test('parses a timestamped RAW line with PGN 127488', () => {
  // CAN ID 09F11201: priority 2, PGN 0x1F112 = 127250? Actually let's pick
  // the right one. 127488 = 0x1F200 → PF=0xF2, PS=0x00 → CAN-ID with PF≥0xF0
  // means PDU2: PGN = DP*0x10000 + PF*256 + PS = 0xF200. Hmm 127488 = 0x1F200,
  // so DP=1, PF=0xF2, PS=0x00. CAN-ID bits 24-25 = DP+R → 01 for DP=1.
  // Priority 6 (typical for engine rapid) → bits 26-28 = 110.
  // CAN ID = (priority<<26) | (R<<25) | (DP<<24) | (PF<<16) | (PS<<8) | SA
  //        = (6<<26) | (0<<25) | (1<<24) | (0xF2<<16) | (0x00<<8) | 0x01
  //        = 0x19F20001
  const line = '00:00:01.234 R 19F20001 00 20 1C FF FF FF FF FF';
  const parsed = parseYDRawLine(line);
  assert.ok(parsed !== null, 'should parse');
  assert.equal(parsed!.pgn, 127488);
  assert.equal(parsed!.source, 0x01);
  assert.deepEqual(
    Array.from(parsed!.data),
    [0x00, 0x20, 0x1c, 0xff, 0xff, 0xff, 0xff, 0xff],
  );
});

test('parses a line without timestamp prefix', () => {
  const line = 'R 19F20001 00 20 1C FF FF FF FF FF';
  const parsed = parseYDRawLine(line);
  assert.ok(parsed !== null);
  assert.equal(parsed!.pgn, 127488);
});

test('PDU1 PGN (PF < 0xF0) — destination is in PS, PGN omits PS', () => {
  // 127245 = 0x1F10D — wait, that's still PF=0xF1 (PDU2). Let me pick a real
  // PDU1 PGN: 60928 = 0xEE00, PF=0xEE, PS=destination. So a PGN-60928 frame
  // with destination 0xFF and source 0x05:
  // CAN-ID = (6<<26)|(0<<25)|(0<<24)|(0xEE<<16)|(0xFF<<8)|0x05 = 0x18EEFF05
  const line = 'R 18EEFF05 11 22 33 44 55 66 77 88';
  const parsed = parseYDRawLine(line);
  assert.ok(parsed !== null);
  // PGN should be 0xEE00 = 60928, not 0xEEFF.
  assert.equal(parsed!.pgn, 60928);
  assert.equal(parsed!.source, 0x05);
});

test('rejects malformed lines', () => {
  assert.equal(parseYDRawLine(''), null);
  assert.equal(parseYDRawLine('garbage'), null);
  assert.equal(parseYDRawLine('R'), null);
  // Wrong-length CAN id token.
  assert.equal(parseYDRawLine('R 12345 AB'), null);
});

test('tolerates extra whitespace and lower-case hex', () => {
  const line = '   R   19f20001   00 20 1c ff ff ff ff ff   ';
  const parsed = parseYDRawLine(line);
  assert.ok(parsed !== null);
  assert.equal(parsed!.pgn, 127488);
});

test('drops non-hex byte tokens after the CAN id', () => {
  // The parser is permissive — it filters byte tokens that aren't 2-hex
  // pairs so vendor-added comments don't break it.
  const line = 'R 19F20001 00 20 1C foo bar';
  const parsed = parseYDRawLine(line);
  assert.ok(parsed !== null);
  assert.deepEqual(Array.from(parsed!.data), [0x00, 0x20, 0x1c]);
});
