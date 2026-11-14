import { checkContentUrl } from '../security/urlPolicy';
import { SECURITY_LIMITS } from '../security/limits';
import type { ClipboardClassification, ClipboardInput, ClipboardIntent } from './types';

export interface HtmlClipboardMarkers {
    readonly hasPrivate: boolean;
    readonly privatePayload: string | null;
    readonly legacyPayload: string | null;
}
export interface ClipboardClassifierHost {
    /** Opaque, network-denied HTML realm; never parse HTML in the vault origin. */
    markers(html: string, signal: AbortSignal): Promise<HtmlClipboardMarkers>;
    /** Bounded worker preflight for large inputs, and JSON shape detection. */
    jsonKind(text: string, signal: AbortSignal): Promise<'excalidraw' | 'native-records' | null>;
    readonly appOrigin: string;
}

function url(value: string, appOrigin: string): string | null {
    const trimmed = value.trim();
    if (!/^https?:\/\//i.test(trimmed)) return null;
    const result = checkContentUrl(trimmed, 'click', { appOrigin });
    return result.ok ? result.url : null;
}
function firstUri(list: string, appOrigin: string): string | null {
    for (const line of list.split(/\r\n|\r|\n/)) {
        const value = line.trim();
        if (!value || value.startsWith('#')) continue;
        return url(value, appOrigin);
    }
    return null;
}
function plain(value: string): ClipboardClassification {
    return { kind: 'text', text: value.replace(/\r\n?/g, '\n') };
}
function svgText(value: string): boolean {
    return /^(?:<\?xml\s[^?]*\?>\s*)?<svg(?:\s|>|\/)/i.test(value.trimStart());
}

export async function classifyClipboard(input: ClipboardInput, intent: ClipboardIntent, host: ClipboardClassifierHost, signal: AbortSignal): Promise<ClipboardClassification> {
    signal.throwIfAborted();
    if (intent === 'drop') {
        if (input.files.length) return { kind: 'files', files: input.files };
        const dropped = input.uriList ? firstUri(input.uriList, host.appOrigin) : null;
        return dropped ? { kind: 'url', url: dropped } : { kind: 'empty' };
    }
    const plainOnly = intent === 'paste-plain' || intent === 'paste-plain-inverted';
    if (plainOnly) {
        if (input.text) return plain(input.text);
        if (input.files.length) return { kind: 'files', files: input.files };
        return input.text !== null ? plain(input.text) : { kind: 'empty' };
    }
    let markers: HtmlClipboardMarkers | null = null;
    if (input.html !== null) {
        if (new Blob([input.html]).size > SECURITY_LIMITS.clipboardHtmlBytes) {
            if (input.text !== null && new Blob([input.text]).size <= 1024 * 1024) return plain(input.text);
            throw new RangeError('Clipboard HTML is too large');
        }
        markers = await host.markers(input.html, signal);
        signal.throwIfAborted();
        if (markers.hasPrivate) return { kind: 'private', encoded: markers.privatePayload ?? '' };
    }
    if (input.privatePng) return { kind: 'private-png', blob: input.privatePng };
    if (input.files.length) return { kind: 'files', files: input.files };
    if (markers?.legacyPayload !== null && markers?.legacyPayload !== undefined) return { kind: 'legacy', envelope: markers.legacyPayload };
    if (input.text !== null) {
        const text = input.text;
        if (text.trimStart().startsWith('{') || text.trimStart().startsWith('[')) {
            let kind: 'excalidraw' | 'native-records' | null = null;
            try { kind = await host.jsonKind(text, signal); } catch { signal.throwIfAborted(); }
            signal.throwIfAborted();
            if (kind === 'excalidraw') return { kind, text };
            if (kind === 'native-records') return { kind, text };
        }
        if (input.svg !== null) return { kind: 'svg', text: input.svg };
        if (svgText(text)) return { kind: 'svg', text };
        const address = url(text, host.appOrigin);
        if (address) return { kind: 'url', url: address };
    }
    if (input.svg !== null) return { kind: 'svg', text: input.svg };
    if (input.html !== null) return { kind: 'html', html: input.html };
    return input.text !== null ? plain(input.text) : { kind: 'empty' };
}
