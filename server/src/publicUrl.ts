import type { Context } from 'hono';
import { getSetting } from './db.js';
import { config } from './config.js';

// Public base URL used to build absolute links (emails, invite links). Prefer
// an explicit operator setting (handles reverse-proxy / public-hostname deploys
// where the request's Host header is the internal one), then env, then the
// incoming request. Trailing slash trimmed.
export function publicBaseUrl(c: Context): string {
  const fromSetting = getSetting('public_base_url');
  if (fromSetting) return fromSetting.replace(/\/+$/, '');
  if (process.env.PUBLIC_BASE_URL) return process.env.PUBLIC_BASE_URL.replace(/\/+$/, '');
  const proto = c.req.header('x-forwarded-proto') || 'http';
  const host = c.req.header('x-forwarded-host') || c.req.header('host');
  if (host) return `${proto}://${host}`;
  return new URL(c.req.url).origin;
}

// Whether to mark cookies Secure. COOKIE_SECURE=true is for the HTTPS address
// behind the proxy; the same box is often also opened over plain HTTP on the
// LAN or Tailscale, where a browser silently drops a Secure cookie and login
// "does nothing". So Secure only when this request really came over HTTPS.
export function secureCookies(c: Context): boolean {
  if (!config.cookieSecure) return false;
  const proto = c.req.header('x-forwarded-proto')?.split(',')[0]?.trim().toLowerCase();
  if (proto) return proto === 'https';
  return new URL(c.req.url).protocol === 'https:';
}
