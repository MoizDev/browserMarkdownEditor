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
async function plain(value: string, signal: AbortSignal): Promise<ClipboardClassification> {
    if (value.length > 2 * SECURITY_LIMITS.textCharacters) throw new RangeError('Clipboard text is too large');
    const parts: string[] = []; let offset = 0, length = 0;
    while (offset < value.length) {
        let end = Math.min(value.length, offset + 65536);
        if (end < value.length && value[end - 1] === '\r') end--;
        const part = value.slice(offset, end).replace(/\r\n?/g, '\n');
        length += part.length;
        if (length > SECURITY_LIMITS.textCharacters) throw new RangeError('Clipboard text is too large');
        parts.push(part); offset = end;
        if (offset < value.length) { signal.throwIfAborted(); await new Promise<void>(resolve => setTimeout(resolve, 0)); signal.throwIfAborted(); }
    }
    return { kind: 'text', text: parts.join('') };
}
async function leading(value: string, signal: AbortSignal): Promise<number> {
    if (value.length > SECURITY_LIMITS.clipboardExpandedBytes) throw new RangeError('Clipboard text is too large');
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
        return dropped ? { kind: 'url', url: dropped } : { kind: 'empty' };
    }
    const plainOnly = intent === 'paste-plain' || intent === 'paste-plain-inverted';
    if (plainOnly) {
        if (input.text) return plain(input.text, signal);
        if (input.files.length) return { kind: 'files', files: input.files };
        return input.text !== null ? plain(input.text, signal) : { kind: 'empty' };
    }
    let markers: HtmlClipboardMarkers | null = null;
    if (input.html !== null) {
        if (new Blob([input.html]).size > SECURITY_LIMITS.clipboardHtmlBytes) {
            if (input.text !== null && new Blob([input.text]).size <= 1024 * 1024) return plain(input.text, signal);
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
    return input.text !== null ? plain(input.text, signal) : { kind: 'empty' };
}
