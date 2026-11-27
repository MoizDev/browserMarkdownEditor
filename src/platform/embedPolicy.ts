import type { EmbedFrameManifest } from './embedContainment.types';

export const EMBED_PROFILE = 'embed-v1' as const;

export const EMBED_PROVIDER_ORIGINS: readonly string[] = Object.freeze([
    'https://www.youtube-nocookie.com', 'https://player.vimeo.com', 'https://www.figma.com', 'https://www.canva.com',
    'https://www.google.com', 'https://www.val.town', 'https://codesandbox.io', 'https://codepen.io', 'https://scratch.mit.edu',
    'https://calendar.google.com', 'https://docs.google.com', 'https://replit.com', 'https://felt.com',
    'https://open.spotify.com', 'https://observablehq.com', 'https://www.desmos.com', 'https://www.tldraw.com',
]);

export const EMBED_PERMISSIONS = [
    'clipboard-read', 'clipboard-write', 'camera', 'microphone', 'geolocation', 'accelerometer', 'gyroscope',
    'magnetometer', 'ambient-light-sensor', 'fullscreen', 'display-capture', 'screen-wake-lock', 'autoplay',
    'encrypted-media', 'picture-in-picture', 'payment', 'usb', 'serial', 'hid', 'bluetooth', 'file-system-access',
    'local-fonts', 'web-share', 'xr-spatial-tracking', 'publickey-credentials-get', 'publickey-credentials-create',
    'storage-access', 'browsing-topics', 'window-management', 'idle-detection', 'web-app-installation',
].map(feature => `${feature} 'none'`).join('; ');

function canonicalOrigin(value: unknown): string {
    if (typeof value !== 'string' || !value) throw new TypeError('Invalid embed origin');
    let url: URL;
    try { url = new URL(value); } catch { throw new TypeError('Invalid embed origin'); }
    const host = url.hostname;
    if (url.protocol !== 'https:' || url.username || url.password || url.port || url.origin !== value ||
        host.includes(':') || /^\d+\.\d+\.\d+\.\d+$/.test(host) || host.endsWith('.') ||
        !host.includes('.') || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') ||
        host.endsWith('.internal') || host.endsWith('.home.arpa') || host.endsWith('.lan') || host.endsWith('.home') ||
        host.endsWith('.test') || host.endsWith('.invalid') || host.endsWith('.example') ||
        host.split('.').some(label => !label || label.length > 63 || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label))) {
        throw new TypeError('Embed origin must be an exact public HTTPS origin');
    }
    return value;
}

/** This manifest is built from the app's curated registry, never from a document. */
export function validateEmbedManifest(value: unknown, appOrigin?: string): EmbedFrameManifest {
    if (!value || typeof value !== 'object') throw new TypeError('Invalid embed manifest');
    const candidate = value as { version?: unknown; origins?: unknown };
    if (candidate.version !== 1 || !Array.isArray(candidate.origins) || !candidate.origins.length) throw new TypeError('Invalid embed manifest');
    let ownOrigin: string | undefined;
    const defaultOrigin = typeof location === 'undefined' || location.origin === 'null' ? undefined : location.origin;
    const origin = appOrigin ?? defaultOrigin;
    if (origin !== undefined) {
        try { ownOrigin = new URL(origin).origin; } catch { throw new TypeError('Invalid app origin'); }
    }
    const seen = new Set<string>(), origins: string[] = [];
    for (const entry of candidate.origins) {
        const valid = canonicalOrigin(entry);
        if (valid === ownOrigin || seen.has(valid)) throw new TypeError('Duplicate or same-origin embed provider');
        seen.add(valid); origins.push(valid);
    }
    return Object.freeze({ version: 1, origins: Object.freeze(origins) });
}

export function validateEmbedUrl(value: unknown, manifest: EmbedFrameManifest): string {
    if (typeof value !== 'string' || value.length > 2048) throw new TypeError('Invalid embed URL');
    const approved = validateEmbedManifest(manifest);
    let url: URL;
    try { url = new URL(value); } catch { throw new TypeError('Invalid embed URL'); }
    if (url.protocol !== 'https:' || url.username || url.password || url.port ||
        url.href !== value || url.href !== url.origin + url.pathname || !approved.origins.includes(url.origin)) {
        throw new TypeError('Embed URL is outside the approved origin');
    }
    return value;
}

export function embedFrameHtml(runtime: string, scriptHash: string, manifest: EmbedFrameManifest): string {
    const approved = validateEmbedManifest(manifest);
    if (typeof runtime !== 'string' || /<\/script/i.test(runtime) ||
        typeof scriptHash !== 'string' || !/^[A-Za-z0-9+/]{42}[AEIMQUYcgkosw048]=$/.test(scriptHash)) {
        throw new TypeError('Invalid contained embed runtime');
    }
    const csp = `default-src 'none'; script-src 'sha256-${scriptHash}'; script-src-attr 'none'; frame-src ${approved.origins.join(' ')}; connect-src 'none'; img-src 'none'; media-src 'none'; font-src 'none'; style-src 'none'; object-src 'none'; worker-src 'none'; base-uri 'none'; form-action 'none'`;
    return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${csp}"></head><body><script>${runtime}</script></body></html>`;
}
