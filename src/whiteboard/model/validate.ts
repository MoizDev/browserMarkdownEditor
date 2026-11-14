import { normalizePaper, PAPER_SIZES, type NotebookPaper } from '../../utils/paper';
import type { Op, TouchedSet, TransactionOrigin } from '../change/ops';
import type { RichText } from '../text/richText';
import { childrenOf, hasOpaqueDescendant, isSheetParent, sheetOf, type BoardDoc } from './doc';
import { isValidId, type NodeId, type ParentId, type SheetId } from './ids';
import { isSafeMediaFile, MEDIA_MIMES, type MediaId } from './media';
import type { Node, NodeKind } from './nodes';
import { isValidKey } from './orderKey';
import type { SampleStoreReader } from './samples';
import {
    ARROWHEADS, DASHES, FIGURE_SHAPES, FILLS, FONTS, H_ALIGNS, SIZES, SWATCHES, TOOLS, V_ALIGNS,
} from './styles';
import { isBlockRange, isSurrogateBoundary, isTextGraphemeBoundary, scanText, spliceBlockCount } from './textOffsets';
import { normalizeRichText } from '../text/richText';
import { MAX_TEXT_BLOCKS, MAX_TEXT_LENGTH } from './textLimits';
export { MAX_TEXT_BLOCKS, MAX_TEXT_LENGTH } from './textLimits';

export type ValidationCode = 'schema' | 'opaque' | 'V-1' | 'V-2' | 'V-3' | 'V-4' | 'V-5'
    | 'V-6' | 'V-7' | 'V-8' | 'V-9' | 'V-10' | 'V-11' | 'V-12';
export type ValidationResult = { readonly ok: true } | {
    readonly ok: false;
    readonly code: ValidationCode;
    readonly opIndex: number;
    readonly nodeId: string | null;
    readonly reason: string;
};
export type ValidationRefusal = Extract<ValidationResult, { readonly ok: false }>;
export interface ValidationContext {
    readonly doc: BoardDoc;
    readonly samples: SampleStoreReader;
    readonly origin?: TransactionOrigin;
}

const OK: ValidationResult = Object.freeze({ ok: true });
const COMMON = ['parent', 'order', 'page', 'x', 'y', 'rotation', 'locked', 'opacity'] as const;
const FIELDS = {
    stroke: ['tool', 'samples', 'pressure', 'widthModel', 'geomVersion', 'fairTol', 'closed', 'width', 'sx', 'sy', 'color', 'fill', 'dash', 'complete'],
    figure: ['shape', 'w', 'h', 'growY', 'color', 'labelColor', 'fill', 'dash', 'size', 'font', 'align', 'valign', 'label', 'width', 'labelScale', 'flipX', 'flipY', 'url'],
    text: ['text', 'color', 'size', 'font', 'align', 'autoSize', 'w', 'scale'],
    sticky: ['text', 'color', 'labelColor', 'size', 'font', 'align', 'valign', 'growY', 'fit', 'scale', 'url'],
    connector: ['route', 'start', 'end', 'bend', 'elbowMid', 'headStart', 'headEnd', 'color', 'labelColor', 'fill', 'dash', 'size', 'font', 'label', 'labelAt', 'width', 'labelScale'],
    polyline: ['points', 'spline', 'color', 'dash', 'size', 'width'],
    frame: ['w', 'h', 'name', 'color'],
    group: [],
    picture: ['w', 'h', 'media', 'crop', 'flipX', 'flipY', 'alt', 'inverted', 'playing', 'url'],
    clip: ['w', 'h', 'media', 'time', 'playing', 'autoplay', 'alt'],
    linkcard: ['w', 'h', 'url', 'preview'],
    embed: ['w', 'h', 'url'],
    opaque: ['raw'],
} as const satisfies Record<NodeKind, readonly string[]>;
const MEDIA_HASH = /^sha256:[0-9a-f]{64}$/;
const NON_WHITESPACE = /\S/;
const MARK_KEYS = ['b', 'i', 'u', 's', 'code', 'hl', 'link', 'x'];
const BLOCK_KINDS = ['p', 'ul', 'ol', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6'];
const NEXT_KEYS = ['color', 'fill', 'dash', 'size', 'font', 'align', 'textAlign', 'valign', 'headStart', 'headEnd', 'route', 'spline', 'highlighterColor'];
const KEYS = {
    extension: ['fields', 'raw'], rich: ['blocks'], block: ['kind', 'level', 'start', 'dir', 'runs', 'tail'],
    run: ['text', 'marks', 'tail'], point: ['x', 'y'], end: ['x', 'y', 'attach'],
    attach: ['target', 'anchor', 'exact', 'precise', 'snap'], crop: ['x0', 'y0', 'x1', 'y1', 'circle'],
    preview: ['title', 'description', 'image', 'favicon'], uniform: ['id'], pressure: ['id', 'rMin', 'rMax'],
    paper: ['size', 'orientation', 'ruling', 'spacing', 'margin', 'pageCount'],
    media: ['id', 'mime', 'bytes', 'w', 'h', 'duration', 'animated', 'name', 'file', 'ext'],
    create: ['t', 'node'], delete: ['t', 'id'], set: ['t', 'id', 'key', 'value'],
    splice: ['t', 'id', 'key', 'from', 'to', 'insert', 'replaceBlocks', 'wholeBlocks'], sheetCreate: ['t', 'op', 'sheet'],
    sheet: ['id', 'name', 'order', 'ext'], recordDelete: ['t', 'op', 'id'],
    sheetSet: ['t', 'op', 'id', 'key', 'value'], board: ['t', 'key', 'value'], mediaAdd: ['t', 'op', 'entry'],
    ext: ['t', 'target', 'id', 'value'], mediaDrop: ['t', 'op', 'id', 'restoreMissing'],
    mediaFile: ['t', 'op', 'id', 'file'], mediaFileRestore: ['t', 'op', 'id', 'file', 'restoreExt'],
} as const;
const VALUES = {
    dir: ['auto', 'ltr', 'rtl'], snap: ['none', 'center', 'edge-point', 'edge'],
    tool: ['pen', 'highlighter'], pressure: ['real', 'none'], route: ['arc', 'elbow'], spline: ['line', 'cubic'],
} as const;
const BAD_RAW_ENTRY = Symbol('invalid raw entry');
export const MAX_COORDINATE = 10_000_000; // R-W21: same world bound for every coordinate.

function refuse(code: ValidationCode, opIndex: number, nodeId: string | null, reason: string): ValidationResult {
    return { ok: false, code, opIndex, nodeId, reason };
}
function object(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function closed(value: Record<string, unknown>, keys: readonly string[]): boolean {
    for (const key in value) if (!Object.hasOwn(value, key) || !keys.includes(key)) return false;
    return true;
}
function known(value: unknown, values: readonly string[]): value is string {
    return typeof value === 'string' && values.includes(value);
}
function number(value: unknown, min = -Infinity, max = Infinity): value is number {
    return typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max;
}
function integer(value: unknown, min = -Number.MAX_SAFE_INTEGER, max = Number.MAX_SAFE_INTEGER): value is number {
    return typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max;
}
function string(value: unknown, max = Infinity): value is string {
    return typeof value === 'string' && value.length <= max;
}
function coordinate(value: unknown): value is number { return number(value, -MAX_COORDINATE, MAX_COORDINATE); }
function boolean(value: unknown): value is boolean { return typeof value === 'boolean'; }
function id(value: unknown): value is NodeId { return typeof value === 'string' && isValidId(value); }
function kind(value: unknown): value is NodeKind { return typeof value === 'string' && Object.hasOwn(FIELDS, value); }

function rawEntry(value: unknown, key: unknown): void {
    if (typeof key !== 'string' || typeof value !== 'string') throw BAD_RAW_ENTRY;
}
function extension(value: unknown): boolean {
    if (value === null) return true;
    if (!object(value) || !closed(value, KEYS.extension) || !(value.fields instanceof Map) || !(value.raw instanceof Map)) return false;
    // RawJson is a reader-owned source value: inspect its carrier, never parse it.
    // Map.forEach with a module callback allocates no iterator or entry pairs.
    try {
        value.fields.forEach(rawEntry);
        value.raw.forEach(rawEntry);
        return true;
    } catch { return false; }
}
function controls(value: string): boolean {
    for (let i = 0; i < value.length; i++) {
        const c = value.charCodeAt(i);
        if (c < 32 || (c >= 127 && c <= 159)) return true; // Unicode C0, DEL and C1 controls.
    }
    return false;
}
function url(value: unknown, embed = false): boolean {
    if (!string(value, 2048) || controls(value)) return false;
    try {
        // R-W18/R-W21: one bounded URL-parser allocation is explicitly allowed.
        const parsed = new URL(value);
        return !parsed.username && !parsed.password && (embed ? parsed.protocol === 'https:'
            : parsed.protocol === 'http:' || parsed.protocol === 'https:' || parsed.protocol === 'mailto:');
    } catch { return false; }
}
function noLoneSurrogates(value: string): boolean {
    for (let i = 0; i < value.length; i++) {
        const c = value.charCodeAt(i);
        if (c >= 0xd800 && c <= 0xdbff) {
            const next = value.charCodeAt(++i);
            if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
        } else if (c >= 0xdc00 && c <= 0xdfff) return false;
    }
    return true;
}
function rawArray(value: unknown): boolean {
    if (typeof value !== 'string') return false;
    let first = 0;
    let last = value.length - 1;
    while (first <= last && (value.charCodeAt(first) === 32 || value.charCodeAt(first) === 9 || value.charCodeAt(first) === 10 || value.charCodeAt(first) === 13)) first++;
    while (last >= first && (value.charCodeAt(last) === 32 || value.charCodeAt(last) === 9 || value.charCodeAt(last) === 10 || value.charCodeAt(last) === 13)) last--;
    return value[first] === '[' && value[last] === ']'; // Reader already validated the opaque JSON value.
}
// V-11, text.md §§4.1/4.3. u/s are supported marks (§4.1); the shortened §4.3
// inventory must not silently turn underline/strike into unsupported data.
function richText(value: unknown): value is RichText {
    if (!object(value) || !closed(value, KEYS.rich) || !Array.isArray(value.blocks)
        || value.blocks.length === 0 || value.blocks.length > MAX_TEXT_BLOCKS) return false;
    let length = value.blocks.length - 1;
    if (length > MAX_TEXT_LENGTH) return false;
    for (let b = 0; b < value.blocks.length; b++) {
        const block = value.blocks[b];
        if (!object(block) || !closed(block, KEYS.block)
            || !known(block.kind, BLOCK_KINDS) || !integer(block.level, 0, 7)
            || (block.kind === 'p' && block.level !== 0) || !known(block.dir, VALUES.dir)
            || (block.start !== undefined && (block.kind !== 'ol' || !number(block.start)))
            || (block.tail !== undefined && !rawArray(block.tail))
            || !Array.isArray(block.runs) || block.runs.length === 0) return false;
        for (let r = 0; r < block.runs.length; r++) {
            const run = block.runs[r];
            if (!object(run) || !closed(run, KEYS.run) || !string(run.text)
                || run.text.includes('\n') || !noLoneSurrogates(run.text)
                || (run.tail !== undefined && !rawArray(run.tail))
                || !object(run.marks) || !closed(run.marks, MARK_KEYS)) return false;
            const marks = run.marks;
            for (let m = 0; m < 6; m++) {
                const flag = marks[MARK_KEYS[m]];
                if (flag !== undefined && flag !== true) return false;
            }
            if (marks.link !== undefined && !url(marks.link)) return false;
            if (marks.x !== undefined && typeof marks.x !== 'string') return false; // Reader-owned RawJson, never parsed.
            length += run.text.length;
            if (length > MAX_TEXT_LENGTH) return false;
        }
    }
    // Adjacent equal-mark runs are merged by the rich splice/model (text §4.3),
    // not refused before that normalization can run.
    return true;
}

export function validRichText(value: unknown): value is RichText {
    try { return richText(value); } catch { return false; }
}

function mediaReference(doc: BoardDoc, value: unknown): boolean {
    return value === null || (typeof value === 'string' && MEDIA_HASH.test(value) && doc.media.has(value as MediaId));
}
function point(value: unknown): boolean {
    return object(value) && closed(value, KEYS.point) && coordinate(value.x) && coordinate(value.y);
}
function end(value: unknown): boolean {
    if (!object(value) || !closed(value, KEYS.end) || !coordinate(value.x) || !coordinate(value.y)) return false;
    if (value.attach === null) return true;
    const a = value.attach;
    return object(a) && closed(a, KEYS.attach) && id(a.target)
        && object(a.anchor) && closed(a.anchor, KEYS.point) && number(a.anchor.x, 0, 1) && number(a.anchor.y, 0, 1)
        && boolean(a.exact) && boolean(a.precise) && known(a.snap, VALUES.snap);
}
function crop(value: unknown): boolean {
    return value === null || (object(value) && closed(value, KEYS.crop)
        && number(value.x0, 0, 1) && number(value.y0, 0, 1) && number(value.x1, 0, 1) && number(value.y1, 0, 1)
        && value.x0 < value.x1 && value.y0 < value.y1 && boolean(value.circle));
}
function preview(doc: BoardDoc, value: unknown): boolean {
    return value === null || (object(value) && closed(value, KEYS.preview)
        && string(value.title, 1000) && string(value.description, 10000)
        && mediaReference(doc, value.image) && mediaReference(doc, value.favicon));
}
function widthModel(value: unknown): boolean {
    if (!object(value)) return false;
    if (value.id === 'uniform') return closed(value, KEYS.uniform);
    return value.id === 'pressure-linear-v1' && closed(value, KEYS.pressure)
        && number(value.rMin, 0) && number(value.rMax, value.rMin);
}
function parentCheck(doc: BoardDoc, parent: unknown, nodeId: string, index: number): ValidationResult {
    // V-2/M-5: reject cycles before mutation (the model's subtree updater assumes a
    // tree). Descendant depth and the cross-op page rules are checked at commit.
    if (!id(parent)) return refuse('V-2', index, nodeId, 'Parent is not a valid id');
    let current: ParentId = parent;
    for (let depth = 1; depth <= 64; depth++) {
        if (current === nodeId) return refuse('V-2', index, nodeId, 'A node cannot be its own ancestor');
        if (isSheetParent(doc, current)) return OK;
        const container = doc.nodes.get(current);
        if (!container || (container.kind !== 'group' && container.kind !== 'frame')) return refuse('V-2', index, nodeId, 'Parent must be a live sheet, group or frame');
        current = container.parent;
    }
    return refuse('V-2', index, nodeId, 'Parent chain exceeds 64 links');
}

function field(context: ValidationContext, nodeKind: NodeKind, nodeId: string, key: string, value: unknown, index: number): ValidationResult {
    const doc = context.doc;
    let valid: boolean;
    let code: ValidationCode = 'V-4';
    switch (key) {
        case 'parent': return parentCheck(doc, value, nodeId, index);
        case 'order': valid = typeof value === 'string' && isValidKey(value); code = 'V-3'; break;
        case 'page': valid = integer(value, -1); code = 'V-7'; break; // Root/nested pairing is final-state V-7.
        case 'x': case 'y': valid = coordinate(value); break;
        case 'rotation': valid = number(value, 0) && value < Math.PI * 2; break;
        case 'opacity': valid = number(value, 0, 1); break;
        case 'w': case 'h': valid = number(value, 1, 1_000_000); break;
        case 'width': valid = number(value, 0.05, 500); break;
        case 'sx': case 'sy': valid = number(value, -1_000_000, 1_000_000) && value !== 0; break;
        case 'growY': case 'time': valid = number(value, 0); break;
        case 'scale': case 'labelScale': valid = number(value, 0.01, 100); break;
        case 'fit': valid = value === null || (number(value, 0, 100) && value > 0); break;
        case 'bend': valid = number(value, -1_000_000, 1_000_000); break;
        case 'elbowMid': case 'labelAt': valid = number(value, 0, 1); break;
        case 'geomVersion': valid = integer(value, 1, 65535); break;
        case 'fairTol': valid = number(value, 0, 1); break;
        case 'locked': case 'closed': case 'complete': case 'flipX': case 'flipY': case 'autoSize':
        case 'inverted': case 'playing': case 'autoplay': valid = boolean(value); code = 'schema'; break;
        case 'color': valid = (nodeKind === 'frame' && value === null) || known(value, SWATCHES); code = 'V-5'; break;
        case 'labelColor': valid = known(value, SWATCHES); code = 'V-5'; break;
        case 'fill': valid = known(value, FILLS); code = 'V-5'; break;
        case 'dash': valid = known(value, DASHES); code = 'V-5'; break;
        case 'size': valid = known(value, SIZES); code = 'V-5'; break;
        case 'font': valid = known(value, FONTS); code = 'V-5'; break;
        case 'align': valid = known(value, nodeKind === 'text' ? V_ALIGNS : H_ALIGNS); code = 'V-5'; break;
        case 'valign': valid = known(value, V_ALIGNS); code = 'V-5'; break;
        case 'shape': valid = known(value, FIGURE_SHAPES); code = 'V-5'; break;
        case 'tool': valid = known(value, VALUES.tool); code = 'V-5'; break;
        case 'pressure': valid = known(value, VALUES.pressure); code = 'V-5'; break;
        case 'route': valid = known(value, VALUES.route); code = 'V-5'; break;
        case 'spline': valid = known(value, VALUES.spline); code = 'V-5'; break;
        case 'headStart': case 'headEnd': valid = known(value, ARROWHEADS); code = 'V-5'; break;
        case 'widthModel': valid = widthModel(value); break;
        case 'samples':
            // V-10: sealed-store acquisition validates finite samples once. A restyle
            // never re-reads every point just to prove the same immutable handle.
            valid = integer(value, 0) && context.samples.has(value) && integer(context.samples.count(value), 1);
            code = 'V-10'; break;
        case 'text': case 'label': valid = (key === 'label' && value === null) || validRichText(value); code = 'V-11'; break;
        case 'start': case 'end': valid = end(value); code = 'V-8'; break; // Targets checked after cross-sheet normalization.
        case 'crop': valid = crop(value); code = 'V-12'; break;
        case 'media': valid = mediaReference(doc, value); code = 'V-9'; break;
        case 'preview': valid = preview(doc, value); code = 'V-9'; break;
        case 'points':
            valid = Array.isArray(value) && value.length >= 2 && value.length <= 5000;
            if (valid) for (let i = 0; i < (value as unknown[]).length; i++) if (!point((value as unknown[])[i])) { valid = false; break; }
            break;
        case 'name': valid = string(value, 1000); code = 'schema'; break;
        case 'alt': valid = string(value, 10000); code = 'schema'; break;
        case 'url':
            valid = (value === null && (nodeKind === 'figure' || nodeKind === 'sticky' || nodeKind === 'picture')) || url(value, nodeKind === 'embed');
            code = 'schema'; break;
        default: return refuse('schema', index, nodeId, `Unknown property ${key}`);
    }
    return valid ? OK : refuse(code, index, nodeId, `Invalid ${key} for ${nodeKind}`);
}

function create(context: ValidationContext, value: unknown, index: number): ValidationResult {
    if (!object(value) || !id(value.id)) return refuse('V-1', index, null, 'Create requires a valid node id');
    const doc = context.doc;
    if (doc.nodes.has(value.id) || doc.sheets.has(value.id as unknown as SheetId)) return refuse('V-1', index, value.id, 'Node id is already used');
    if (!kind(value.kind)) return refuse('V-5', index, value.id, 'Unknown node kind');
    if (value.kind === 'opaque') return refuse('opaque', index, value.id, `Opaque node ${value.id} can only be acquired by load`);
    if (!extension(value.ext)) return refuse('schema', index, value.id, 'Invalid preservation metadata');
    const specific: readonly string[] = FIELDS[value.kind];
    for (const key in value) if (!Object.hasOwn(value, key) || (key !== 'id' && key !== 'kind' && key !== 'ext'
        && !(COMMON as readonly string[]).includes(key) && !specific.includes(key))) return refuse('schema', index, value.id, `Unknown node property ${key}`);
    for (let i = 0; i < COMMON.length; i++) {
        const result = field(context, value.kind, value.id, COMMON[i], value[COMMON[i]], index);
        if (!result.ok) return result;
    }
    for (let i = 0; i < specific.length; i++) {
        const result = field(context, value.kind, value.id, specific[i], value[specific[i]], index);
        if (!result.ok) return result;
    }
    // V-6: groups may be temporarily empty/one-child while a batch constructs or
    // dissolves them. CH §2.3 normalizes first; validateCommit checks the result.
    return OK;
}
function nextStyles(value: unknown): boolean {
    return object(value) && closed(value, NEXT_KEYS) && known(value.color, SWATCHES) && known(value.fill, FILLS)
        && known(value.dash, DASHES) && known(value.size, SIZES) && known(value.font, FONTS)
        && known(value.align, H_ALIGNS) && known(value.textAlign, V_ALIGNS) && known(value.valign, V_ALIGNS)
        && known(value.headStart, ARROWHEADS) && known(value.headEnd, ARROWHEADS)
        && known(value.route, VALUES.route) && known(value.spline, VALUES.spline) && known(value.highlighterColor, SWATCHES);
}
function paper(value: unknown): boolean {
    if (!object(value) || !closed(value, KEYS.paper) || typeof value.size !== 'string' || !Object.hasOwn(PAPER_SIZES, value.size)) return false;
    // V-5 checks the normalizer's own size data, not a second list. Its legacy
    // `in` lookup also accepts prototype names, which are not paper sizes.
    // R-W21 exception: this rare op uses the one authoritative normalizer and its
    // result allocation, never a second copy of paper defaults/clamps.
    const normalized = normalizePaper(value as Partial<NotebookPaper>);
    return value.size === normalized.size && value.orientation === normalized.orientation && value.ruling === normalized.ruling
        && value.spacing === normalized.spacing && value.margin === normalized.margin && value.pageCount === normalized.pageCount;
}
function mediaEntry(value: unknown): boolean {
    return object(value) && closed(value, KEYS.media)
        && typeof value.id === 'string' && MEDIA_HASH.test(value.id) && known(value.mime, MEDIA_MIMES)
        && integer(value.bytes, 0) && number(value.w, 1, 1_000_000) && number(value.h, 1, 1_000_000)
        && (value.mime.startsWith('video/') ? number(value.duration, 0) : value.duration === null)
        && boolean(value.animated) && string(value.name, 10000) && (value.file === null || string(value.file)) && extension(value.ext);
}
function sheetName(value: unknown): boolean { return string(value, 200) && NON_WHITESPACE.test(value); }

// H-3: context.doc is the staged live read-side, after earlier ops, before this op.
// CH-1 captures inverses and rolls back on refusal. One context is reused per session;
// no overlay or per-op request object is constructed here. Ordinary locks are a
// tool/adapter policy (R-W21), never confused with opaque-content protection.
export function validateOp(context: ValidationContext, op: unknown, opIndex: number): ValidationResult {
    let nodeId: string | null = null;
    try {
        if (!object(op)) return refuse('schema', opIndex, null, 'Op must be an object');
        const doc = context.doc;
        if (typeof op.id === 'string') nodeId = op.id;
        switch (op.t) {
            case 'create':
                return closed(op, KEYS.create) ? create(context, op.node, opIndex) : refuse('schema', opIndex, nodeId, 'Unknown create field');
            case 'delete': case 'set': case 'splice': {
                if (!id(op.id)) return refuse('V-1', opIndex, nodeId, 'Op requires a valid node id');
                const node = doc.nodes.get(op.id);
                if (!node) return refuse('V-1', opIndex, op.id, 'Node does not exist');
                if (node.kind === 'opaque') return refuse('opaque', opIndex, node.id, `Opaque node ${node.id} cannot be edited or deleted`);
                if (op.t === 'delete') {
                    if (!closed(op, KEYS.delete)) return refuse('schema', opIndex, op.id, 'Unknown delete field');
                    return childrenOf(doc, node.id).length === 0 ? OK : refuse('V-2', opIndex, node.id, 'Delete requires children to be removed first');
                }
                if (op.t === 'set') {
                    if (!closed(op, KEYS.set) || typeof op.key !== 'string'
                        || (!(COMMON as readonly string[]).includes(op.key) && !(FIELDS[node.kind] as readonly string[]).includes(op.key))) return refuse('schema', opIndex, node.id, 'Property is not editable on this node kind');
                    return field(context, node.kind, node.id, op.key, op.value, opIndex);
                }
                if (!closed(op, KEYS.splice) || (op.key !== 'text' && op.key !== 'label')
                    || !Object.hasOwn(node, op.key)) return refuse('V-11', opIndex, node.id, 'Splice requires a text-bearing property');
                const text: RichText | null = Reflect.get(node, op.key);
                const length = scanText(text);
                if (!integer(op.from, 0, length) || !integer(op.to, op.from, length)
                    || !isSurrogateBoundary(text, op.from) || !isSurrogateBoundary(text, op.to)
                    || !isTextGraphemeBoundary(text, op.from) || !isTextGraphemeBoundary(text, op.to)) return refuse('V-11', opIndex, node.id, 'Splice offsets must be ordered grapheme boundaries within the text');
                if (op.wholeBlocks !== undefined && (op.wholeBlocks !== true || op.replaceBlocks !== undefined || (context.origin !== 'undo' && context.origin !== 'redo' && context.origin !== 'revert') || !isBlockRange(text, op.from, op.to))) return refuse('V-11', opIndex, node.id, 'Whole-block inverse must be block-aligned');
                if (op.replaceBlocks !== undefined && (op.replaceBlocks !== true || !isBlockRange(text, op.from, op.to))) return refuse('V-11', opIndex, node.id, 'Block replacement must be block-aligned');
                if (!validRichText(op.insert) || (op.replaceBlocks === true && normalizeRichText(op.insert) !== op.insert)
                    || length - (op.to - op.from) + scanText(op.insert) > MAX_TEXT_LENGTH
                    || spliceBlockCount(text, op.from, op.to, op.insert.blocks.length) > MAX_TEXT_BLOCKS) return refuse('V-11', opIndex, node.id, 'Splice fragment or resulting text/block count is invalid');
                return OK;
            }
            case 'sheet': {
                if (op.op === 'create') {
                    const s = op.sheet;
                    if (!closed(op, KEYS.sheetCreate) || !object(s) || !closed(s, KEYS.sheet) || !id(s.id)) return refuse('V-1', opIndex, null, 'Sheet create requires a valid record');
                    if (doc.sheets.has(s.id as unknown as SheetId) || doc.nodes.has(s.id)) return refuse('V-1', opIndex, s.id, 'Sheet id is already used');
                    if (doc.sheets.size >= 40) return refuse('schema', opIndex, null, 'Maximum 40 sheets reached');
                    if (!sheetName(s.name) || !extension(s.ext)) return refuse('schema', opIndex, null, 'Invalid sheet name or metadata');
                    return typeof s.order === 'string' && isValidKey(s.order) ? OK : refuse('V-3', opIndex, null, 'Invalid sheet order key');
                }
                if (!id(op.id) || !doc.sheets.has(op.id as unknown as SheetId)) return refuse('V-1', opIndex, null, 'Sheet does not exist');
                const sheet = op.id as unknown as SheetId;
                if (op.op === 'delete') {
                    if (!closed(op, KEYS.recordDelete)) return refuse('schema', opIndex, null, 'Unknown sheet delete field');
                    if (doc.sheets.size <= 1) return refuse('schema', opIndex, null, 'A board must keep at least one sheet');
                    return !doc.bySheet.get(sheet)?.size ? OK : refuse('V-2', opIndex, null, 'Sheet still contains live nodes');
                }
                if (op.op !== 'set' || !closed(op, KEYS.sheetSet)) return refuse('schema', opIndex, null, 'Unknown sheet operation');
                if (op.key === 'name') return sheetName(op.value) ? OK : refuse('schema', opIndex, null, 'Sheet name must be nonblank and at most 200 characters');
                if (op.key === 'order') return typeof op.value === 'string' && isValidKey(op.value) ? OK : refuse('V-3', opIndex, null, 'Invalid sheet order key');
                return refuse('schema', opIndex, null, 'Unknown sheet property');
            }
            case 'ext': {
                if ((context.origin !== 'undo' && context.origin !== 'redo' && context.origin !== 'revert') || !closed(op, KEYS.ext) || !extension(op.value)) return refuse('schema', opIndex, nodeId, 'Invalid internal extension restore');
                switch (op.target) {
                    case 'node': {
                        if (!id(op.id)) return refuse('V-1', opIndex, nodeId, 'Extension node id is invalid');
                        const node = doc.nodes.get(op.id);
                        if (!node) return refuse('V-1', opIndex, op.id, 'Extension node does not exist');
                        return node.kind === 'opaque' ? refuse('opaque', opIndex, node.id, `Opaque node ${node.id} cannot be edited`) : OK;
                    }
                    case 'sheet': return id(op.id) && doc.sheets.has(op.id as unknown as SheetId) ? OK : refuse('V-1', opIndex, null, 'Extension sheet does not exist');
                    case 'media': return typeof op.id === 'string' && MEDIA_HASH.test(op.id) && doc.media.has(op.id as MediaId) ? OK : refuse('V-9', opIndex, null, 'Extension media does not exist');
                    case 'pen': case 'view': return op.id === undefined ? OK : refuse('schema', opIndex, null, 'Board extension target has no id');
                    case 'paper': return op.id === undefined && doc.host.kind === 'notebook' ? OK : refuse('schema', opIndex, null, 'Paper extension does not exist');
                    case 'host': return op.id === undefined && doc.host.kind === 'pdf-ink' ? OK : refuse('schema', opIndex, null, 'PDF host extension does not exist');
                    default: return refuse('schema', opIndex, nodeId, 'Unknown extension target');
                }
            }
            case 'board':
                if (!closed(op, KEYS.board) || typeof op.key !== 'string') return refuse('schema', opIndex, null, 'Invalid board op');
                switch (op.key) {
                    case 'host.paper': return doc.host.kind === 'notebook' && paper(op.value) ? OK : refuse('V-4', opIndex, null, 'Paper must equal its authoritative normalized form');
                    case 'host.pdf': return doc.host.kind === 'pdf-ink' && typeof op.value === 'string' ? OK : refuse('schema', opIndex, null, 'PDF bookkeeping must be an opaque reader-owned RawJson value');
                    case 'ui.tool': return known(op.value, TOOLS) ? OK : refuse('V-5', opIndex, null, 'Unknown tool');
                    case 'ui.next': return nextStyles(op.value) ? OK : refuse('V-5', opIndex, null, 'Invalid next-node styles');
                    case 'ui.penWidth': return number(op.value, 0.36, 10.5) ? OK : refuse('V-4', opIndex, null, 'Pen width must be 0.36 through 10.5');
                    case 'view.grid': case 'view.focusMode': case 'view.toolLock': case 'view.transparent': case 'view.debugMode':
                        return boolean(op.value) ? OK : refuse('schema', opIndex, null, 'View flag must be boolean');
                    default: return refuse('schema', opIndex, null, 'Unknown board property');
                }
            case 'media':
                if (op.op === 'set-file') {
                    const restores = 'restoreExt' in op;
                    if ((restores && (context.origin !== 'revert' || !extension(op.restoreExt)))
                        || !closed(op, restores ? KEYS.mediaFileRestore : KEYS.mediaFile) || typeof op.id !== 'string' || !MEDIA_HASH.test(op.id)
                        || !isSafeMediaFile(op.file)) return refuse('V-9', opIndex, null, 'Media filename must be a bounded safe .Assets leaf or null');
                    return doc.media.has(op.id as MediaId) ? OK : refuse('V-9', opIndex, null, 'Media does not exist');
                }
                if (op.op === 'add') {
                    if (!closed(op, KEYS.mediaAdd) || !mediaEntry(op.entry)) return refuse('V-9', opIndex, null, 'Invalid media entry');
                    if (doc.media.has((op.entry as { id: MediaId }).id)) return refuse('V-9', opIndex, null, 'Media id is already used');
                    return OK;
                }
                if (op.op === 'drop' && closed(op, KEYS.mediaDrop) && typeof op.id === 'string' && MEDIA_HASH.test(op.id)) {
                    const media = op.id as MediaId;
                    if (!doc.media.has(media)) return refuse('V-9', opIndex, null, 'Media does not exist');
                    if (op.restoreMissing !== undefined && (op.restoreMissing !== true || (context.origin !== 'undo' && context.origin !== 'redo' && context.origin !== 'revert'))) return refuse('schema', opIndex, null, 'Only an inverse can restore a missing media entry');
                    if (doc.mediaRefs.get(media)?.size) return refuse('V-9', opIndex, null, 'Media is still referenced by live nodes');
                    return op.restoreMissing === true || !(doc.preservedMediaRefs.get(media) ?? 0)
                        ? OK : refuse('V-9', opIndex, null, 'Media is still referenced by preserved data');
                }
                return refuse('schema', opIndex, null, 'Unknown media operation');
            default: return refuse('schema', opIndex, nodeId, 'Unknown op type');
        }
    } catch {
        // A malformed object/getter or a bad external store answer is a refusal,
        // never an exception after the caller has begun staging earlier ops.
        return refuse('schema', opIndex, nodeId, 'Malformed op value');
    }
}

function finalNode(context: ValidationContext, node: Node, index: number): ValidationResult {
    const doc = context.doc;
    const parent = parentCheck(doc, node.parent, node.id, index);
    if (!parent.ok) return parent;
    // V-7 deliberately waits until paired parent/page writes and normalization finish.
    if (doc.kind === 'whiteboard' || !isSheetParent(doc, node.parent)) {
        if (node.page !== -1) return refuse('V-7', index, node.id, 'Whiteboard/nested nodes must have page -1');
    } else if (!integer(node.page, 0)) return refuse('V-7', index, node.id, 'Paged root node requires a non-negative page index');
    // V-6's preserved-opaque exception follows document-model §9.3/RV-22.
    if (node.kind === 'group' && childrenOf(doc, node.id).length < 2 && !hasOpaqueDescendant(doc, node.id)) return refuse('V-6', index, node.id, 'Normalization must dissolve a group with fewer than two children');
    // V-10 waits for paired samples/pressure writes, just as V-7 waits for
    // parent/page. A staged mismatch is allowed; an unencodable stroke is not.
    if (node.kind === 'stroke') {
        if (!context.samples.has(node.samples) || context.samples.count(node.samples) < 1) return refuse('V-10', index, node.id, 'Stroke requires sealed nonempty samples');
        const mode = context.samples.pressureMode(node.samples);
        if (node.pressure !== mode || (node.widthModel.id === 'pressure-linear-v1' && mode !== 'real')) return refuse('V-10', index, node.id, 'Stroke pressure and width model must agree with sealed sample pressure');
    }
    if (node.kind === 'connector') {
        const sheet = sheetOf(doc, node.id);
        for (let i = 0; i < 2; i++) {
            const attach = (i === 0 ? node.start : node.end).attach;
            if (!attach) continue;
            const target = doc.nodes.get(attach.target);
            if (!target || target.id === node.id || target.kind === 'connector' || target.kind === 'group' || target.kind === 'opaque'
                || sheet === undefined || sheetOf(doc, target.id) !== sheet) return refuse('V-8', index, node.id, 'Attachment target is missing, forbidden or on another sheet');
        }
    }
    return OK;
}
function incomingAttachments(context: ValidationContext, id: NodeId, index: number): ValidationResult {
    const incoming = context.doc.attachedTo.get(id);
    if (!incoming) return OK;
    for (const connectorId of incoming) {
        const connector = context.doc.nodes.get(connectorId);
        if (!connector || connector.kind !== 'connector') return refuse('V-8', index, connectorId, 'Attachment index refers to a missing connector');
        const result = finalNode(context, connector, index);
        if (!result.ok) return result;
    }
    return OK;
}

function finalSubtree(context: ValidationContext, id: NodeId, index: number, depth: number): ValidationResult {
    if (depth > 64) return refuse('V-2', index, id, 'Moved subtree exceeds 64 links');
    const node = context.doc.nodes.get(id);
    if (!node) return OK;
    const result = finalNode(context, node, index);
    if (!result.ok) return result;
    const incoming = incomingAttachments(context, id, index);
    if (!incoming.ok) return incoming;
    const children = childrenOf(context.doc, id);
    for (let i = 0; i < children.length; i++) {
        const child = finalSubtree(context, children[i].id, index, depth + 1);
        if (!child.ok) return child;
    }
    return OK;
}

// R-W18 two-phase contract: call AFTER CH-1 normalization, BEFORE history/scene/save
// consumers or notices. touched includes follow-on ops and affected parent groups.
// The forward ops identify moved roots so a mere group restyle never scans its
// subtree. A moved subtree already costs O(subtree) in the model's index upkeep.
export function validateCommit(context: ValidationContext, touched: TouchedSet, forward: readonly Op[], opIndex: number): ValidationResult {
    try {
        for (const id of touched.nodes) {
            const node = context.doc.nodes.get(id);
            if (node) {
                const result = finalNode(context, node, opIndex);
                if (!result.ok) return result;
            }
            // A deleted/moved target can have an untouched connector outside its
            // subtree. Its reverse-index bucket must be normalized too (V-8).
            const incoming = incomingAttachments(context, id, opIndex);
            if (!incoming.ok) return incoming;
        }
        for (let i = 0; i < forward.length; i++) {
            const op = forward[i];
            if (op.t !== 'set' || op.key !== 'parent') continue;
            const result = finalSubtree(context, op.id, i, 1);
            if (!result.ok) return result;
        }
        return OK;
    } catch { return refuse('schema', opIndex, null, 'Malformed staged document'); }
}
