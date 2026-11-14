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

function visitRun(head: string, length: number, ring: Uint8Array | undefined, position: number,
    seen: Set<MediaId> | undefined, visit: (id: MediaId) => void): Set<MediaId> | undefined {
    if (length < HASH_LENGTH) return seen;
    seen = visitHash(head, seen, visit);
    if (length > HASH_LENGTH) {
        let tail = '';
        for (let j = 0; j < HASH_LENGTH; j++) tail += String.fromCharCode(ring![(position + j) & 63]);
        seen = visitHash(tail, seen, visit);
    }
    return seen;
}

// R-W25/R-W37: escaped string/key discovery covers filenames, URLs and suffixed
// ids. Long hex runs also contribute their first/last 64 characters (cafe<hash>
// is still a dependency). A 64-byte ring avoids materializing long strings or
// allocating a sliding substring per character; false positives keep data safe.
function* scanRawMediaSteps(raw: RawJson, visit: (id: MediaId) => void): Generator<void, void> {
    let nextYield = 4096;
    let seen: Set<MediaId> | undefined;
    let ring: Uint8Array | undefined;
    let i = 0;
    while (i < raw.length) {
        if (i >= nextYield) { nextYield = i + 4096; yield; }
        if (raw.charCodeAt(i++) !== 34) continue;
        let candidate = '';
        let length = 0;
        let position = 0;
        let closed = false;
        while (i < raw.length) {
            if (i >= nextYield) { nextYield = i + 4096; yield; }
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
                else {
                    if (length === HASH_LENGTH) {
                        if (!ring) ring = new Uint8Array(HASH_LENGTH);
                        for (let j = 0; j < HASH_LENGTH; j++) ring[j] = candidate.charCodeAt(j);
                        position = 0;
                    }
                    ring![position] = code;
                    position = (position + 1) & 63;
                }
                length++;
            } else {
                seen = visitRun(candidate, length, ring, position, seen, visit);
                candidate = '';
                length = 0;
            }
        }
        if (!closed) throw new RangeError('Unterminated string in preserved JSON');
        seen = visitRun(candidate, length, ring, position, seen, visit);
    }
}

export function scanRawMedia(raw: RawJson, visit: (id: MediaId) => void): void {
    const steps = scanRawMediaSteps(raw, visit);
    while (!steps.next().done) { /* synchronous transaction visitor */ }
}
export async function scanRawMediaIncremental(raw: RawJson, visit: (id: MediaId) => void, cooperate: () => Promise<void>): Promise<void> {
    const steps = scanRawMediaSteps(raw, visit);
    let started = performance.now();
    for (;;) {
        if (steps.next().done) return;
        if (performance.now() - started >= 3) { await cooperate(); started = performance.now(); }
    }
}
export function* extRawValues(ext: ExtBag | null): Iterable<RawJson> {
    if (!ext) return;
    yield* ext.fields.values();
    yield* ext.raw.values();
}
export function visitExtRaw(ext: ExtBag | null, visit: (raw: RawJson) => void): void {
    for (const raw of extRawValues(ext)) visit(raw);
}
export function* richTextRawValues(text: RichText | null): Iterable<RawJson | null> {
    if (!text) return;
    let count = 0;
    for (let b = 0; b < text.blocks.length; b++) {
        const block = text.blocks[b];
        if (block.tail !== undefined) yield block.tail;
        for (let r = 0; r < block.runs.length; r++) {
            const run = block.runs[r];
            if (run.tail !== undefined) yield run.tail;
            if (run.marks.x !== undefined) yield run.marks.x;
            if ((++count & 255) === 0) yield null;
        }
    }
}
export function visitRichTextRaw(text: RichText | null, visit: (raw: RawJson) => void): void {
    for (const raw of richTextRawValues(text)) if (raw !== null) visit(raw);
}

// The reader can use this before sample admission: these are precisely the node
// fields that retain unknown content, not a temporary original-line/source slice.
export type NodeRawCarrier = Pick<OpaqueNode, 'kind' | 'ext' | 'raw'>
    | Pick<TextNode | StickyNode, 'kind' | 'ext' | 'text'>
    | Pick<FigureNode | ConnectorNode, 'kind' | 'ext' | 'label'>
    | { readonly kind: Exclude<NodeKind, 'opaque' | 'text' | 'sticky' | 'figure' | 'connector'>; readonly ext: ExtBag | null };

export function* nodeRawValues(node: NodeRawCarrier): Iterable<RawJson | null> {
    yield* extRawValues(node.ext);
    if (node.kind === 'opaque') yield node.raw;
    else if (node.kind === 'text' || node.kind === 'sticky') yield* richTextRawValues(node.text);
    else if (node.kind === 'figure' || node.kind === 'connector') yield* richTextRawValues(node.label);
}
export function visitNodeRaw(node: NodeRawCarrier, visit: (raw: RawJson) => void): void {
    for (const raw of nodeRawValues(node)) if (raw !== null) visit(raw);
}
export function* hostRawValues(host: HostBlock): Iterable<RawJson> {
    if (host.kind === 'pdf-ink') { yield host.pdf; yield* extRawValues(host.ext); }
    else if (host.kind === 'notebook') yield* extRawValues(host.ext);
}
export function visitHostRaw(host: HostBlock, visit: (raw: RawJson) => void): void {
    for (const raw of hostRawValues(host)) visit(raw);
}
export function* preservedRawValues(preserved: PreservedBlock): Iterable<RawJson> {
    yield* preserved.fields.values();
    for (const record of preserved.records) yield record.raw;
    yield* extRawValues(preserved.end);
}
export function visitPreservedRaw(preserved: PreservedBlock, visit: (raw: RawJson) => void): void {
    for (const raw of preservedRawValues(preserved)) visit(raw);
}
