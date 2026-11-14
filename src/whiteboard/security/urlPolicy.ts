import { SECURITY_LIMITS } from './limits';

export type UrlUse = 'click' | 'preview' | 'embed';
export type UrlDecision = { readonly ok: true; readonly url: string } | { readonly ok: false; readonly reason: string };
export interface UrlEnvironment {
    readonly appOrigin: string;
    readonly helperOrigin?: string;
}

function publicV4(bytes: readonly number[]): boolean {
    const [a, b, c] = bytes;
    if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
    if (a === 100 && b >= 64 && b <= 127) return false;
    if (a === 169 && b === 254) return false;
    if (a === 172 && b >= 16 && b <= 31) return false;
    if (a === 192 && (b === 168 || (b === 0 && (c === 0 || c === 2)) || (b === 88 && c === 99))) return false;
    if (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) return false;
    if (a === 203 && b === 0 && c === 113) return false;
    return true;
}
function v4(host: string): number[] | null {
    const parts = host.split('.');
    if (parts.length !== 4 || parts.some(part => !/^\d{1,3}$/u.test(part) || Number(part) > 255)) return null;
    return parts.map(Number);
}
function v6(host: string): number[] | null {
    const text = host.slice(1, -1);
    const halves = text.split('::');
    if (halves.length > 2) return null;
    const parse = (part: string) => part ? part.split(':') : [];
    const left = parse(halves[0]), right = parse(halves[1] ?? '');
    const missing = 8 - left.length - right.length;
    if (missing < 0 || (halves.length === 1 && missing !== 0) || (halves.length === 2 && missing < 1)) return null;
    const words = [...left, ...Array<string>(missing).fill('0'), ...right];
    if (words.some(word => !/^[0-9a-f]{1,4}$/iu.test(word))) return null;
    return words.map(word => parseInt(word, 16));
}
function publicHost(hostname: string): boolean {
    const host = hostname.toLowerCase().replace(/\.$/u, '');
    if (host.startsWith('[') && host.endsWith(']')) {
        const words = v6(host);
        if (!words) return false;
        if (words.slice(0, 5).every(value => value === 0) && words[5] === 0xffff) {
            return publicV4([words[6] >>> 8, words[6] & 255, words[7] >>> 8, words[7] & 255]);
        }
        // Global-unicast only; reject documentation, protocol-assignment and 6to4
        // ranges rather than permitting IPv4 tunnel forms to bypass the IPv4 policy.
        return (words[0] & 0xe000) === 0x2000 && words[0] !== 0x2002
            && !(words[0] === 0x2001 && ((words[1] & 0xfe00) === 0 || words[1] === 0x0db8));
    }
    const address = v4(host);
    if (address) return publicV4(address);
    if (!host.includes('.') || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) return false;
    return true;
}

/** Clicks may navigate local destinations. Network-capable preview/embed use additionally
 * excludes special literal addresses and our own endpoints; this cannot detect DNS rebinding. */
export function checkContentUrl(value: string, use: UrlUse, environment: UrlEnvironment): UrlDecision {
    if (typeof value !== 'string' || value.length > SECURITY_LIMITS.urlCharacters
        || value.startsWith('//') || (use !== 'click' && use !== 'preview' && use !== 'embed')) {
        return { ok: false, reason: 'URL is not an admissible absolute address' };
    }
    for (let index = 0; index < value.length; index++) {
        const code = value.charCodeAt(index);
        if (code <= 32 || code === 127) return { ok: false, reason: 'URL contains a control or whitespace character' };
    }
    let url: URL;
    try { url = new URL(value); }
    catch { return { ok: false, reason: 'URL is invalid or relative' }; }
    if (url.username || url.password) return { ok: false, reason: 'URL credentials are not allowed' };
    if (use === 'click') {
        if (url.protocol !== 'http:' && url.protocol !== 'https:' && url.protocol !== 'mailto:') return { ok: false, reason: 'URL scheme is not clickable' };
        return { ok: true, url: url.href };
    }
    if ((url.protocol !== 'http:' && url.protocol !== 'https:') || (use === 'embed' && url.protocol !== 'https:')) {
        return { ok: false, reason: 'URL scheme is not permitted for this request' };
    }
    let app: URL, helper: URL | undefined;
    try {
        app = new URL(environment.appOrigin);
        helper = environment.helperOrigin ? new URL(environment.helperOrigin) : undefined;
    } catch { return { ok: false, reason: 'Host security origins are invalid' }; }
    if (url.origin === app.origin || (helper && url.origin === helper.origin) || !publicHost(url.hostname)) {
        return { ok: false, reason: 'Network destination is not allowed' };
    }
    return { ok: true, url: url.href };
}
