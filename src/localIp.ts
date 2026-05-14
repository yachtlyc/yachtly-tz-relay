/**
 * SECURITY: Mirrors the RFC 1918 / .local / 127.0.0.1 allow-list used by the
 * dashboard's `app/yachtly-connect/lib/localNetworkGuard.ts`. WebSocket clients
 * from any other origin are refused with HTTP 403.
 *
 * Accepts IPv4-mapped IPv6 (`::ffff:192.168.x.x`), bare IPv6 loopback (`::1`),
 * and `.local` mDNS hostnames.
 */
export function isLocalIP(rawHost: string): boolean {
  if (!rawHost) return false;
  // Strip IPv6 v4-mapped prefix.
  const host = rawHost.replace(/^::ffff:/, '');

  if (host === '::1') return true;
  if (host === 'localhost' || host === '127.0.0.1') return true;
  if (/^10\./.test(host)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(host)) return true;
  if (/^192\.168\./.test(host)) return true;
  if (/^169\.254\./.test(host)) return true;
  if (/\.local$/.test(host)) return true;
  return false;
}
