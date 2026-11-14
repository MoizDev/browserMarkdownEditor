import type { HostBlock, PreservedBlock } from './doc';
import type { ExtBag, RawJson } from './json';
import type { MediaId } from './media';
import type { ConnectorNode, FigureNode, NodeKind, OpaqueNode, StickyNode, TextNode } from './nodes';
import type { RichText } from '../text/richText';

const PREFIX = 'sha256:';
const HASH_LENGTH = 64;

function hex(code: number): number {
    if (code >= 48 && code <= 57) return code - 48;
    if (code >= 65 && code <= 70) return code - 55;
    if (code >= 97 && code <= 102) return code - 87;
    throw new RangeError('Invalid Unicode escape in preserved JSON');
}

function visitHash(hash: string, seen: Set<MediaId> | undefined, visit: (id: MediaId) => void): Set<MediaId> {
    const id = (PREFIX + hash) as MediaId;
    if (!seen) seen = new Set();
    if (!seen.has(id)) { seen.add(id); visit(id); }
    return seen;
}

// R-W25/R-W37: lexical discovery, not a parser for unknown data. A maximal run
// of 64 lowercase hex characters anywhere in a string/key also covers filenames,
// URLs and suffixed ids. A false positive keeps data; a false negative can trash it.
// Decode at most a 64-character candidate, never an arbitrarily large string token.
export function scanRawMedia(raw: RawJson, visit: (id: MediaId) => void): void {
    let seen: Set<MediaId> | undefined;
    let i = 0;
    while (i < raw.length) {
        if (raw.charCodeAt(i++) !== 34) continue;
        let candidate = '';
        let length = 0;
        let closed = false;
        while (i < raw.length) {
            let code = raw.charCodeAt(i++);
            if (code === 34) { closed = true; break; }
            if (code === 92) {
                if (i === raw.length) throw new RangeError('Truncated escape in preserved JSON');
                const escape = raw.charCodeAt(i++);
                switch (escape) {
                    case 34: case 47: case 92: code = escape; break;
                    case 98: code = 8; break;
                    case 102: code = 12; break;
                    case 110: code = 10; break;
                    case 114: code = 13; break;
                    case 116: code = 9; break;
                    case 117:
                        if (i + 4 > raw.length) throw new RangeError('Truncated Unicode escape in preserved JSON');
                        code = (hex(raw.charCodeAt(i)) << 12) | (hex(raw.charCodeAt(i + 1)) << 8)
                            | (hex(raw.charCodeAt(i + 2)) << 4) | hex(raw.charCodeAt(i + 3));
                        i += 4;
                        break;
                    default: throw new RangeError('Invalid escape in preserved JSON');
                }
            } else if (code < 32) throw new RangeError('Unescaped control character in preserved JSON');
            if ((code >= 48 && code <= 57) || (code >= 97 && code <= 102)) {
                if (length < HASH_LENGTH) candidate += String.fromCharCode(code);
                else candidate = ''; // Longer runs are not a 64-character hash; bound retained text.
                length++;
            } else {
                if (length === HASH_LENGTH) seen = visitHash(candidate, seen, visit);
                candidate = '';
                length = 0;
            }
        }
        if (!closed) throw new RangeError('Unterminated string in preserved JSON');
        if (length === HASH_LENGTH) seen = visitHash(candidate, seen, visit);
    }
}

export function visitExtRaw(ext: ExtBag | null, visit: (raw: RawJson) => void): void {
    if (!ext) return;
    for (const raw of ext.fields.values()) visit(raw);
    for (const raw of ext.raw.values()) visit(raw);
}

export function visitRichTextRaw(text: RichText | null, visit: (raw: RawJson) => void): void {
    if (!text) return;
    for (let b = 0; b < text.blocks.length; b++) {
        const block = text.blocks[b];
        if (block.tail !== undefined) visit(block.tail);
        for (let r = 0; r < block.runs.length; r++) {
            const run = block.runs[r];
            if (run.tail !== undefined) visit(run.tail);
            if (run.marks.x !== undefined) visit(run.marks.x);
        }
    }
}

// The reader can use this before sample admission: these are precisely the node
// fields that retain unknown content, not a temporary original-line/source slice.
export type NodeRawCarrier = Pick<OpaqueNode, 'kind' | 'ext' | 'raw'>
    | Pick<TextNode | StickyNode, 'kind' | 'ext' | 'text'>
    | Pick<FigureNode | ConnectorNode, 'kind' | 'ext' | 'label'>
    | { readonly kind: Exclude<NodeKind, 'opaque' | 'text' | 'sticky' | 'figure' | 'connector'>; readonly ext: ExtBag | null };

export function visitNodeRaw(node: NodeRawCarrier, visit: (raw: RawJson) => void): void {
    visitExtRaw(node.ext, visit);
    if (node.kind === 'opaque') visit(node.raw);
    else if (node.kind === 'text' || node.kind === 'sticky') visitRichTextRaw(node.text, visit);
    else if (node.kind === 'figure' || node.kind === 'connector') visitRichTextRaw(node.label, visit);
}

export function visitHostRaw(host: HostBlock, visit: (raw: RawJson) => void): void {
    if (host.kind === 'pdf-ink') { visit(host.pdf); visitExtRaw(host.ext, visit); }
    else if (host.kind === 'notebook') visitExtRaw(host.ext, visit);
}

export function visitPreservedRaw(preserved: PreservedBlock, visit: (raw: RawJson) => void): void {
    for (const raw of preserved.fields.values()) visit(raw);
    for (let i = 0; i < preserved.records.length; i++) visit(preserved.records[i].raw);
    visitExtRaw(preserved.end, visit);
}
