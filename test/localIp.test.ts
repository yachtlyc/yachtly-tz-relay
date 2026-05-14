import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isLocalIP } from '../src/localIp.ts';

test('accepts RFC 1918 / loopback / link-local / .local addresses', () => {
  for (const ip of [
    '127.0.0.1',
    'localhost',
    '10.0.0.5',
    '10.255.255.255',
    '172.16.0.1',
    '172.31.0.1',
    '192.168.1.42',
    '169.254.10.1',
    'signalk.local',
    'nav-pc.local',
    '::1',
    '::ffff:192.168.1.10',
  ]) {
    assert.equal(isLocalIP(ip), true, `should accept ${ip}`);
  }
});

test('refuses public IPs and other non-local addresses', () => {
  for (const ip of [
    '8.8.8.8',
    '1.1.1.1',
    '172.32.0.1', // outside the 16-31 range
    '172.15.0.1', // outside the 16-31 range
    '11.0.0.1',
    'example.com',
    'attacker.example',
    '',
  ]) {
    assert.equal(isLocalIP(ip), false, `should reject ${ip}`);
  }
});
