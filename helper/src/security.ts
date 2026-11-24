// The checks that decide who may talk to the helper. Pure, so the tests can
// pin every rule without a socket.
//
// Threat model: the helper listens on loopback, but every web page the user
// opens can send requests to 127.0.0.1, and DNS rebinding can make a hostile
// page's own hostname resolve there. So:
//   • browsers always send `Origin` on WebSocket upgrades and cross-origin
//     fetches → the editor's exact origin is required for /ws and CORS on /health;
//   • a rebound page still carries its own name in `Host` → Host must be the
//     loopback literal we are bound to;
//   • the agent CLIs call /mcp from a native process and never send `Origin` →
//     any request that carries one there is a browser and is refused.

import { randomBytes, timingSafeEqual } from 'node:crypto';

/** Lower-cased `scheme://host[:port]`, default ports dropped; null if not an origin. */
export function normalizeOrigin(value: string | null | undefined): string | null {
    if (!value || value === 'null') return null;
    let url: URL;
    try {
        url = new URL(value);
    } catch {
        return null;
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    // An origin has no path, query, fragment or credentials; a value that does
    // is not something a browser sent.
    if ((url.pathname !== '/' && url.pathname !== '') || url.search || url.hash || url.username || url.password) return null;
    if (value.endsWith('/')) return null;
    return url.origin.toLowerCase();
}

export interface OriginPolicy {
    /** Exact origins (production + build-time extras). */
    exact: ReadonlySet<string>;
    /** `serve --dev`: also any http://localhost:* / http://127.0.0.1:* (the Vite dev server). */
    dev: boolean;
}

const DEV_ORIGIN = /^http:\/\/(localhost|127\.0\.0\.1)(:\d{1,5})?$/;

export function makeOriginPolicy(origins: readonly string[], dev: boolean): OriginPolicy {
    const exact = new Set<string>();
    for (const o of origins) {
        const n = normalizeOrigin(o);
        if (n) exact.add(n);
    }
    return { exact, dev };
}

export function isAllowedOrigin(origin: string | null | undefined, policy: OriginPolicy): boolean {
    const n = normalizeOrigin(origin);
    if (!n) return false;
    if (policy.exact.has(n)) return true;
    return policy.dev && DEV_ORIGIN.test(n);
}

/** Host header must name the loopback interface we bound, with our port. */
export function isAllowedHost(host: string | null | undefined, port: number): boolean {
    if (!host) return false;
    const h = host.toLowerCase();
    return h === `127.0.0.1:${port}` || h === `localhost:${port}`;
}

/** 256 random bits, URL-safe. Bound to one run; see runs.ts. */
export function newRunToken(): string {
    return randomBytes(32).toString('base64url');
}

const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;
export function looksLikeToken(value: string): boolean {
    return TOKEN_RE.test(value);
}

/** `Authorization: Bearer <t>` must equal the token in the path, compared in constant time. */
export function bearerMatches(authorization: string | null | undefined, pathToken: string): boolean {
    if (!authorization) return false;
    const m = /^Bearer\s+(\S+)$/i.exec(authorization.trim());
    if (!m) return false;
    const a = Buffer.from(m[1]);
    const b = Buffer.from(pathToken);
    return a.length === b.length && timingSafeEqual(a, b);
}
