const MAX_URI_BYTES = 8 * 1024;
const ALLOWED_SCHEMES = new Set(['http:', 'https:', 'mailto:', 'tel:']);

/** The worker returns raw URI text; this is the only boundary before it becomes an action. */
export function safePdfUri(value: string | Uint8Array): string | null {
    let text: string;
    if (typeof value === 'string') {
        text = value;
    } else {
        if (value.byteLength > MAX_URI_BYTES) return null;
        try { text = new TextDecoder('utf-8', { fatal: true }).decode(value); }
        catch { return null; }
    }
    if (!text || text.length > MAX_URI_BYTES || text !== text.trim() || new TextEncoder().encode(text).length > MAX_URI_BYTES) return null;
    // URL parsing replaces lone surrogates and strips controls, hiding the input that was supplied.
    for (let i = 0; i < text.length; i++) {
        const c = text.charCodeAt(i);
        if (c <= 0x1f || (c >= 0x7f && c <= 0x9f) || c === 0x061c || c === 0x200e || c === 0x200f ||
            (c >= 0x202a && c <= 0x202e) || (c >= 0x2066 && c <= 0x2069)) return null;
        if (c >= 0xd800 && c <= 0xdbff) {
            const next = text.charCodeAt(++i);
            if (!(next >= 0xdc00 && next <= 0xdfff)) return null;
        } else if (c >= 0xdc00 && c <= 0xdfff) return null;
    }
    if (!/^[a-z][a-z\d+.-]*:/i.test(text) || /%(?![\da-f]{2})/i.test(text)) return null;
    try {
        const url = new URL(text);
        if (!ALLOWED_SCHEMES.has(url.protocol)) return null;
        if ((url.protocol === 'http:' || url.protocol === 'https:') &&
            (!/^https?:\/\//i.test(text) || !url.hostname || url.username || url.password || text.includes('\\'))) return null;
        return url.href;
    } catch { return null; }
}
