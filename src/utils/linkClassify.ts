const LOCAL_BASE = 'https://vault.invalid/';
const LOCAL_ORIGIN = new URL(LOCAL_BASE).origin;
const URI_SCHEME = /^[a-z][a-z\d+.-]*:/i;
const BARE_EMAIL = /^[^\s@<>:]+@[^\s@<>:]+\.[^\s@<>]+$/;
const BARE_WWW = /^www\.[^\s<>]+$/i;

function hasControl(text: string): boolean {
    for (let i = 0; i < text.length; i++) {
        const code = text.charCodeAt(i);
        if (code < 32 || code === 127) return true;
    }
    return false;
}

function nonLocal(text: string): boolean {
    const candidate = BARE_WWW.test(text) ? `https://${text}`
        : BARE_EMAIL.test(text) ? `mailto:${text}` : text;
    try {
        const url = new URL(candidate, LOCAL_BASE);
        return URI_SCHEME.test(candidate) || url.origin !== LOCAL_ORIGIN;
    } catch {
        return true;
    }
}

export function localMarkdownTarget(raw: string, allowParent = false): string | null {
    if (hasControl(raw)) return null;
    const text = raw.trim();
    if (!text || text.startsWith('//') || /[\\?#]/.test(text) || nonLocal(text)) return null;

    const parts: string[] = [];
    for (const part of text.split('/')) {
        let decoded: string;
        try { decoded = decodeURIComponent(part); }
        catch { return null; }
        // Decode components, never arbitrary URL text: an encoded separator
        // must not turn https%3A%2F%2Fhost into a local README basename.
        if (hasControl(decoded) || /[\\/?#]/.test(decoded)) return null;
        if (!decoded || decoded === '.') continue;
        if (decoded === '..') {
            if (parts.length && parts[parts.length - 1] !== '..') parts.pop();
            else if (allowParent && !text.startsWith('/')) parts.push('..');
            else return null;
        } else {
            parts.push(decoded);
        }
    }
    if (!parts.length || /^[a-z]:$/i.test(parts[0])) return null;
    const path = `${text.startsWith('/') ? '/' : ''}${parts.join('/')}`;
    return nonLocal(path) ? null : path;
}
