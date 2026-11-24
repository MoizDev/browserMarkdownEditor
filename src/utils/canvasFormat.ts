export type CanvasFormat = 'native' | 'legacy-drawing' | 'legacy-notebook' | 'notebook-blank' | 'empty' | 'not-a-board';
export type CanvasKind = 'whiteboard' | 'notebook' | 'pdf-ink';
export interface CanvasSniff {
    format: CanvasFormat;
    kind?: CanvasKind;
    expectedKind: CanvasKind;
    kindMismatch: boolean;
}

interface Header {
    native: boolean;
    kind?: CanvasKind;
    fence: boolean;
    document: boolean;
    hasDocument: boolean;
    store: boolean;
    schema: boolean;
    paper: boolean;
    hasPaper: boolean;
}

/** A lexical walk, not a deserializer: retain only the envelope's few keys.
 *  Balanced brackets alone are insufficient: `{"document":…,broken}` must
 *  never pass this gate and reach today's parse-error → writable-blank path. */
function scan(text: string, prefix: boolean): { header: Header; valid: boolean } {
    const limit = text.length;
    const header: Header = { native: false, fence: false, document: false, hasDocument: false, store: false, schema: false, paper: false, hasPaper: false };
    let i = 0;
    let nativeHeader = false;
    const space = () => {
        while (i < limit && (text[i] === ' ' || text[i] === '\t' || text[i] === '\r' || text[i] === '\n')) i++;
    };
    const digit = (c: string | undefined) => c !== undefined && c >= '0' && c <= '9';
    const string = (): boolean => {
        if (text[i++] !== '"') return false;
        while (i < limit) {
            const c = text[i++];
            if (c === '"') return true;
            if (c.charCodeAt(0) < 32) return false;
            if (c !== '\\') continue;
            if (i >= limit) return false;
            const escape = text[i++];
            if (escape === 'u') {
                if (i + 4 > limit) return false;
                for (let n = 0; n < 4; n++) {
                    const hex = text[i++];
                    if (!((hex >= '0' && hex <= '9') || (hex >= 'a' && hex <= 'f') || (hex >= 'A' && hex <= 'F'))) return false;
                }
            } else if (!'"\\/bfnrt'.includes(escape)) return false;
        }
        return false;
    };
    // Only short keys/header strings are decoded, never records or payloads.
    const smallString = (start: number, maxLength = 96): string | undefined => {
        if (text[start] !== '"' || i - start > maxLength) return undefined;
        return JSON.parse(text.slice(start, i)) as string;
    };
    const value = (depth: number, scope?: 'root' | 'document'): boolean => {
        if (depth > 128 || i >= limit) return false;
        const c = text[i];
        if (c === '"') return string();
        if (c === '{' || c === '[') {
            i++;
            space();
            const close = c === '{' ? '}' : ']';
            if (text[i] === close) { i++; return true; }
            while (i < limit) {
                let key: string | undefined;
                if (c === '{') {
                    const start = i;
                    if (!string()) return false;
                    if (scope) key = smallString(start);
                    space();
                    if (text[i++] !== ':') return false;
                    space();
                }
                const start = i;
                const object = text[i] === '{';
                if (scope === 'root' && key === 'document') {
                    header.document = object;
                    header.hasDocument = true;
                    header.store = header.schema = false;
                }
                if (!value(depth + 1, scope === 'root' && key === 'document' ? 'document' : undefined)) return false;
                if (scope === 'root') {
                    if (key === 'format' && smallString(start) === 'board') header.native = true;
                    if (key === 'kind') {
                        const kind = smallString(start);
                        header.kind = kind === 'whiteboard' || kind === 'notebook' || kind === 'pdf-ink' ? kind : undefined;
                    }
                    if (key === 'fence') {
                        const fence = smallString(start, 256);
                        header.fence = fence === 'compat-1' || !!fence?.startsWith('compat-1:') || text.startsWith('"compat-1:', start);
                    }
                    if (key === 'paper') { header.hasPaper = true; header.paper = object; }
                    // Canonical native files need only their header, not a walk
                    // through megabytes of points. Reordered keys use the full
                    // lexical walk; format still takes precedence over document.
                    if (prefix && header.native && header.kind) { nativeHeader = true; return true; }
                } else if (scope === 'document') {
                    if (key === 'store') header.store = object;
                    if (key === 'schema') header.schema = object;
                }
                space();
                if (i >= limit) return false;
                if (text[i] === close) { i++; return true; }
                if (text[i++] !== ',') return false;
                space();
                // A trailing comma is not JSON and the old reader rejects it.
                if (text[i] === close) return false;
            }
            return false;
        }
        for (const literal of ['true', 'false', 'null']) {
            if (i + literal.length <= limit && text.startsWith(literal, i)) { i += literal.length; return true; }
        }
        if (c === '-') i++;
        if (text[i] === '0') i++;
        else {
            if (!digit(text[i]) || text[i] === '0') return false;
            while (i < limit && digit(text[i])) i++;
        }
        if (i < limit && text[i] === '.') {
            i++;
            if (i >= limit || !digit(text[i])) return false;
            while (i < limit && digit(text[i])) i++;
        }
        if (i < limit && (text[i] === 'e' || text[i] === 'E')) {
            i++;
            if (text[i] === '+' || text[i] === '-') i++;
            if (i >= limit || !digit(text[i])) return false;
            while (i < limit && digit(text[i])) i++;
        }
        return i <= limit;
    };
    const valid = text[0] === '{' && value(0, 'root');
    space();
    return { header, valid: nativeHeader || (valid && i === text.length) };
}

/** The guard-release classifier. No library, DOM, filesystem or engine imports.
 *  A native header wins even when its body is damaged: this build cannot edit
 *  either. Legacy input, however, must be complete JSON before it may mount. */
export function sniffCanvas(text: string, ext: string): CanvasSniff {
    const name = ext.toLowerCase();
    const expectedKind: CanvasKind = name.endsWith('.notebook') || name === 'notebook' ? 'notebook'
        : name.endsWith('.pdf') || name === 'pdf' ? 'pdf-ink' : 'whiteboard';
    const result = (format: CanvasFormat, kind?: CanvasKind): CanvasSniff => ({
        format, kind, expectedKind,
        kindMismatch: kind !== undefined && kind !== expectedKind && !(format === 'legacy-drawing' && expectedKind === 'pdf-ink'),
    });
    const source = text.trim(); // includes a leading BOM; never changes the caller's bytes
    if (!source) return result('empty', expectedKind);
    if (source[0] !== '{') return result('not-a-board');
    const first = scan(source.slice(0, 256), true);
    if (first.header.native && first.header.kind) return result('native', first.header.kind);
    const { header, valid } = source.length <= 256 ? first : scan(source, false);
    if (header.native) return result('native', header.kind);
    // PDF's inert old-attachment fence must not stand up a library editor even
    // when board.json is missing; the PDF role reader owns attachment precedence.
    if (!valid || header.fence || (header.hasPaper && !header.paper)) return result('not-a-board');
    if (header.document && header.store && header.schema) {
        return header.paper ? result('legacy-notebook', 'notebook') : result('legacy-drawing', 'whiteboard');
    }
    if (!header.hasDocument && header.paper) return result('notebook-blank', 'notebook');
    return result('not-a-board');
}

/** Shared by the notice and the app/agent write-authority seams. */
export function canvasReadOnlyReason(sniff: CanvasSniff): string | null {
    if (sniff.kindMismatch) {
        const actual = sniff.kind === 'notebook' ? 'a notebook' : sniff.kind === 'pdf-ink' ? 'PDF annotations' : 'a drawing';
        const expected = sniff.expectedKind === 'notebook' ? 'a notebook' : sniff.expectedKind === 'pdf-ink' ? 'PDF annotations' : 'a drawing';
        return `This file contains ${actual}, but its name selects ${expected}. It is open read-only so its geometry is not reinterpreted.`;
    }
    if (sniff.format === 'native') return 'This file uses the new drawing format. This version of the app cannot edit it.';
    if (sniff.format === 'not-a-board') return 'This file is not a drawing this app can read.';
    return null;
}
