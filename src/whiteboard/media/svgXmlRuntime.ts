import { gifHeader, jpegHeader, pngHeader, webpHeader } from './headers';
import { isoHeader } from './isoHeaders';
import { sniffMedia } from './sniff';

// Run the lexical cap before passing bytes to the opaque XML profile.
export function preflightSvgText(text: string): void {
    if (new TextEncoder().encode(text).length > 5 * 1024 * 1024 || /<!\s*(?:DOCTYPE|ENTITY)\b/i.test(text)) throw new Error('Unsafe SVG');
    let depth = 0, elements = 0;
    for (let i = 0; i < text.length;) {
        if (text[i] !== '<') { i++; continue; }
        if (text.startsWith('<!--', i)) {
            const end = text.indexOf('-->', i + 4);
            if (end < 0) throw new Error('Invalid SVG comment');
            i = end + 3; continue;
        }
        if (text.startsWith('<![CDATA[', i)) {
            const end = text.indexOf(']]>', i + 9);
            if (end < 0) throw new Error('Invalid SVG CDATA');
            i = end + 3; continue;
        }
        if (text.startsWith('<?', i)) {
            const end = text.indexOf('?>', i + 2);
            if (end < 0) throw new Error('Invalid SVG instruction');
            i = end + 2; continue;
        }
        if (text.startsWith('<!', i)) throw new Error('Unsupported SVG declaration');
        const closing = text[i + 1] === '/';
        let quote = '', end = i + 1;
        for (; end < text.length; end++) {
            const c = text[end];
            if (quote) { if (c === quote) quote = ''; }
            else if (c === '"' || c === "'") quote = c;
            else if (c === '>') break;
        }
        if (end >= text.length || quote) throw new Error('Invalid SVG tag');
        if (closing) {
            if (--depth < 0) throw new Error('Invalid SVG nesting');
        } else {
            if (++elements > 50000 || ++depth > 64) throw new Error('SVG is too complex');
            let last = end - 1;
            while (last > i && /\s/.test(text[last])) last--;
            if (text[last] === '/') depth--;
        }
        i = end + 1;
    }
    if (depth !== 0) throw new Error('Invalid SVG nesting');
}

// This function runs only in the opaque, network-denied XML profile. Parsed
// nodes never leave that realm or enter its live document.
export function svgHeaderInIsolatedRealm(text: string): { width: number; height: number; rgbaBytes: number } {
    const budget = { bytes: new TextEncoder().encode(text).length, pixels: 0, documents: 0 };
    const image = inspectDocument(text, budget, 0);
    return { ...image, rgbaBytes: budget.pixels * 4 };
}

function inspectDocument(text: string, budget: { bytes: number; pixels: number; documents: number }, level: number): { width: number; height: number } {
    if (level > 64 || ++budget.documents > 50000) throw new Error('SVG inline resources are too complex');
    preflightSvgText(text);
    const parsed = new DOMParser().parseFromString(text, 'image/svg+xml');
    const root = parsed.documentElement;
    if (root.localName !== 'svg' || root.namespaceURI !== 'http://www.w3.org/2000/svg' || parsed.getElementsByTagName('parsererror').length) throw new Error('Invalid SVG');
    if (/\b(?:width|height)\s*:/i.test(root.getAttribute('style') ?? '')) throw new Error('SVG intrinsic dimensions cannot be safely established');
    const chargeData = (value: string): void => {
        const matches = value.matchAll(/data:[^\s"'<>)]*/gi);
        for (const match of matches) {
            const url = match[0], comma = url.indexOf(',');
            if (comma < 0) throw new Error('Invalid SVG inline resource');
            const metadata = url.slice(5, comma), encoded = url.slice(comma + 1);
            let bytes: Uint8Array;
            if (/;base64$/i.test(metadata)) {
                if (encoded.length > Math.ceil((5 * 1024 * 1024 - budget.bytes) * 4 / 3) + 4) throw new Error('SVG inline resources exceed the limit');
                const raw = atob(encoded);
                bytes = Uint8Array.from(raw, c => c.charCodeAt(0));
            } else {
                const out = new Uint8Array(encoded.length);
                let used = 0;
                for (let i = 0; i < encoded.length; i++) {
                    if (encoded[i] === '%') {
                        if (!/^[0-9a-f]{2}$/i.test(encoded.slice(i + 1, i + 3))) throw new Error('Invalid SVG inline resource');
                        out[used++] = parseInt(encoded.slice(i + 1, i + 3), 16); i += 2;
                    } else {
                        const c = encoded.charCodeAt(i);
                        if (c > 127) throw new Error('Invalid SVG inline resource');
                        out[used++] = c;
                    }
                }
                bytes = out.subarray(0, used);
            }
            budget.bytes += bytes.length;
            if (budget.bytes > 5 * 1024 * 1024) throw new Error('SVG inline resources exceed the limit');
            const mime = sniffMedia(bytes);
            if (mime === 'image/svg+xml') {
                inspectDocument(new TextDecoder('utf-8', { fatal: true }).decode(bytes), budget, level + 1);
                continue;
            }
            const header = mime === 'image/png' ? pngHeader(bytes) : mime === 'image/jpeg' ? jpegHeader(bytes)
                : mime === 'image/gif' ? gifHeader(bytes) : mime === 'image/webp' ? webpHeader(bytes)
                    : mime === 'image/avif' ? isoHeader(bytes, 'avif') : null;
            if (!header) throw new Error('Unsupported SVG inline resource');
            budget.pixels += header.decodePixels ?? header.width * header.height;
            if (budget.pixels > 2 ** 26) throw new Error('SVG inline resources exceed the pixel limit');
        }
    };
    const stack: Element[] = [root];
    while (stack.length) {
        const node = stack.pop()!;
        for (const attr of Array.from(node.attributes)) {
            if (attr.value.includes('\\')) throw new Error('SVG resource escapes cannot be safely budgeted');
            chargeData(attr.value);
        }
        if (node.localName === 'style') {
            const css = node.textContent ?? '';
            if (css.includes('\\')) throw new Error('SVG resource escapes cannot be safely budgeted');
            if (/\b(?:width|height)\s*:/i.test(css)) throw new Error('SVG intrinsic dimensions cannot be safely established');
            chargeData(css);
        }
        for (const child of Array.from(node.children)) stack.push(child);
    }
    const length = (value: string | null): number | null => {
        if (!value) return null;
        const match = /^\s*([+]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?)\s*(px|in|cm|mm|q|pt|pc)?\s*$/i.exec(value);
        if (!match) return null;
        const unit = (match[2] ?? 'px').toLowerCase();
        const factors: Record<string, number> = { px: 1, in: 96, cm: 96 / 2.54, mm: 96 / 25.4, q: 96 / 101.6, pt: 96 / 72, pc: 16 };
        const n = Number(match[1]) * factors[unit];
        return Number.isFinite(n) && n > 0 ? n : null;
    };
    let width = length(root.getAttribute('width')), height = length(root.getAttribute('height'));
    const viewBoxText = root.getAttribute('viewBox');
    const view = viewBoxText?.trim().split(/[\s,]+/).map(Number);
    if (view && view.length === 4 && view.every(Number.isFinite) && view[2] > 0 && view[3] > 0) {
        if (width && !height) height = width * view[3] / view[2];
        else if (height && !width) width = height * view[2] / view[3];
        else if (!width && !height) { width = view[2]; height = view[3]; }
    }
    if (!width || !height) throw new Error('SVG has no usable dimensions');
    width = Math.ceil(width); height = Math.ceil(height);
    if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width > (2 ** 26) / height) throw new RangeError('Invalid or oversized SVG');
    budget.pixels += width * height;
    if (budget.pixels > 2 ** 26) throw new RangeError('SVG inline resources exceed the pixel limit');
    return { width, height };
}
