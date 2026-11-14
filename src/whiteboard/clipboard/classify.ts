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
    if (value.length > SECURITY_LIMITS.textCharacters) return null;
    const trimmed = value.trim();
    if (!/^https?:\/\//i.test(trimmed)) return null;
    const result = checkContentUrl(trimmed, 'click', { appOrigin });
    return result.ok ? result.url : null;
}
async function firstUriLine(list: string, signal: AbortSignal): Promise<string | null> {
    if (list.length > SECURITY_LIMITS.clipboardHtmlBytes) throw new RangeError('Clipboard URI list is too large');
    let start = 0;
    for (let i = 0; i <= list.length; i++) {
        if ((i & 65535) === 65535) { signal.throwIfAborted(); await new Promise<void>(resolve => setTimeout(resolve, 0)); signal.throwIfAborted(); }
        if (i !== list.length && list[i] !== '\r' && list[i] !== '\n') continue;
        if (i - start > SECURITY_LIMITS.textCharacters) throw new RangeError('Clipboard URI line is too large');
        const value = list.slice(start, i).trim();
        if (value && !value.startsWith('#')) return value;
        if (list[i] === '\r' && list[i + 1] === '\n') i++;
        start = i + 1;
    }
    return null;
}
async function firstUri(list: string, appOrigin: string, signal: AbortSignal): Promise<string | null> {
    const value = await firstUriLine(list, signal);
    return value ? url(value, appOrigin) : null;
}
function plain(value: string): ClipboardClassification {
    if (value.length > SECURITY_LIMITS.textCharacters) throw new RangeError('Clipboard text is too large');
    return { kind: 'text', text: value.replace(/\r\n?/g, '\n') };
}
async function leading(value: string, signal: AbortSignal): Promise<number> {
    let index = 0;
    while (index < value.length && /\s/u.test(value[index])) {
        if ((++index & 65535) === 0) { signal.throwIfAborted(); await new Promise<void>(resolve => setTimeout(resolve, 0)); signal.throwIfAborted(); }
    }
    return index;
}
function svgText(value: string, start: number): boolean {
    return value[start] === '<' && /^(?:<\?xml\s[^?]*\?>\s*)?<svg(?:\s|>|\/)/i.test(value.slice(start));
}

export async function classifyClipboard(input: ClipboardInput, intent: ClipboardIntent, host: ClipboardClassifierHost, signal: AbortSignal): Promise<ClipboardClassification> {
    signal.throwIfAborted();
    if (intent === 'drop') {
        if (input.files.length) return { kind: 'files', files: input.files };
        const dropped = input.uriList ? await firstUri(input.uriList, host.appOrigin, signal) : null;
        if (dropped) return { kind: 'url', url: dropped };
        if (input.svg !== null) return { kind: 'svg', text: input.svg };
        if (input.html !== null) {
            if (new Blob([input.html]).size > SECURITY_LIMITS.clipboardHtmlBytes) throw new RangeError('Clipboard HTML is too large');
            return { kind: 'html', html: input.html };
        }
        if (input.text !== null) {
            const start = await leading(input.text, signal);
            if (input.text[start] === '{' || input.text[start] === '[') {
                const kind = await host.jsonKind(input.text, signal);
                signal.throwIfAborted();
                if (kind) return { kind, text: input.text };
            }
            const address = url(input.text, host.appOrigin);
            if (address) return { kind: 'url', url: address };
            if (svgText(input.text, start)) return { kind: 'svg', text: input.text };
            return plain(input.text);
        }
        return { kind: 'empty' };
    }
    const plainOnly = intent === 'paste-plain' || intent === 'paste-plain-inverted';
    if (plainOnly) {
        if (input.text) return plain(input.text);
        if (input.files.length) return { kind: 'files', files: input.files };
        if (input.text !== null) return plain(input.text);
        if (input.uriList) {
            const first = await firstUriLine(input.uriList, signal);
            if (first) return plain(first);
        }
        return { kind: 'empty' };
    }
    let markers: HtmlClipboardMarkers | null = null;
    if (input.html !== null) {
        if (new Blob([input.html]).size > SECURITY_LIMITS.clipboardHtmlBytes) throw new RangeError('Clipboard HTML is too large');
        markers = await host.markers(input.html, signal);
        signal.throwIfAborted();
        if (markers.hasPrivate) return { kind: 'private', encoded: markers.privatePayload ?? '' };
    }
    if (input.privatePng) return { kind: 'private-png', blob: input.privatePng };
    if (input.files.length) return { kind: 'files', files: input.files };
    if (markers?.legacyPayload !== null && markers?.legacyPayload !== undefined) return { kind: 'legacy', envelope: markers.legacyPayload };
    const uri = input.uriList ? await firstUri(input.uriList, host.appOrigin, signal) : null;
    if (uri) return { kind: 'url', url: uri };
    if (input.text !== null) {
        const text = input.text, start = await leading(input.text, signal);
        if (text[start] === '{' || text[start] === '[') {
            // Syntax/unrecognized input is a null result. A worker budget,
            // identity or transport failure must not silently become plain text.
            const kind = await host.jsonKind(text, signal);
            signal.throwIfAborted();
            if (kind === 'excalidraw') return { kind, text };
            if (kind === 'native-records') return { kind, text };
        }
        if (input.svg !== null) return { kind: 'svg', text: input.svg };
        if (svgText(text, start)) return { kind: 'svg', text };
        const address = url(text, host.appOrigin);
        if (address) return { kind: 'url', url: address };
    }
    if (input.svg !== null) return { kind: 'svg', text: input.svg };
    if (input.html !== null) return { kind: 'html', html: input.html };
    return input.text !== null ? plain(input.text) : { kind: 'empty' };
}
