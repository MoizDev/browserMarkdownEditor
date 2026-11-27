import { randomBytes, timingSafeEqual } from 'node:crypto';

export function normalizeOrigin(value: string | null | undefined): string | null {
    if (!value || value === 'null') return null;
    let url: URL;
    try {
        url = new URL(value);
    } catch {
        return null;
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    if ((url.pathname !== '/' && url.pathname !== '') || url.search || url.hash || url.username || url.password) return null;
    if (value.endsWith('/')) return null;
    return url.origin.toLowerCase();
}

export interface OriginPolicy {
    exact: ReadonlySet<string>;
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

export function isAllowedHost(host: string | null | undefined, port: number): boolean {
    if (!host) return false;
    const h = host.toLowerCase();
    return h === `127.0.0.1:${port}` || h === `localhost:${port}`;
}

export function newRunToken(): string {
    return randomBytes(32).toString('base64url');
}

const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;
export function looksLikeToken(value: string): boolean {
    return TOKEN_RE.test(value);
}

export function bearerMatches(authorization: string | null | undefined, pathToken: string): boolean {
    if (!authorization) return false;
    const m = /^Bearer\s+(\S+)$/i.exec(authorization.trim());
    if (!m) return false;
    const a = Buffer.from(m[1]);
    const b = Buffer.from(pathToken);
    return a.length === b.length && timingSafeEqual(a, b);
}
