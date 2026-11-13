// FMT-1; native-format §§3,5,6,10. These are file types, not the live model.
export const NATIVE_VERSION = [1, 0] as const;
export const FORMAT_LIMITS = Object.freeze({
    fileBytes: 1024 ** 3,
    records: 5_000_000,
    recordBytes: 64 * 1024 ** 2,
    pointsChars: 48 * 1024 ** 2,
    points: 1_000_000,
    textChars: 1_000_000,
    richTextDepth: 32,
    jsonDepth: 128, // security §3.2 also bounds inert future values
    idChars: 128,
    sheets: 1_000, // 40 is the creation UI's cap, not a file rejection rule
    parentDepth: 64,
    world: 10_000_000,
    // R-W11: notebook page setting is finite here; model/normalizePaper clamps to 1..500.
    // R-W11: authored PDF page facts are not clamped (PDF stream/C2.3; 06-text 10k-page fixtures).
    pdfPages: 65_536,
    pdfPageSize: 14_400,
});

export type JsonValue = null | boolean | number | string | readonly JsonValue[] | JsonObject;
export interface JsonObject { readonly [key: string]: JsonValue; }
interface FutureFields { readonly [key: string]: unknown; }
export type BoardFileKind = 'whiteboard' | 'notebook' | 'pdf-ink';
export type MediaId = `sha256:${string}`;
export type Bounds = readonly [number, number, number, number];
export type RecordCategory = 'pen' | 'view' | 'paper' | 'host' | 'media' | 'sheet' | 'node' | 'opaque' | 'end';
export const RECORD_ORDER: readonly RecordCategory[] = ['pen', 'view', 'paper', 'host', 'media', 'sheet', 'node', 'opaque', 'end'];
export const MEDIA_MIMES = [
    'image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif', 'image/svg+xml',
    'video/mp4', 'video/webm', 'video/quicktime',
] as const; // security SEC-4, not the older model §8 list (which omitted AVIF)
export type MediaMime = typeof MEDIA_MIMES[number];

export interface NativeHeader extends FutureFields {
    readonly format: 'board';
    readonly version: readonly [number, number];
    readonly kind: BoardFileKind;
    readonly fence?: string;
    readonly document?: JsonValue; // ignored by our reader when format is board
}
export interface NativeEnvelope extends NativeHeader { readonly records: readonly NativeRecord[]; }
export interface PenRecord extends FutureFields {
    readonly type: 'pen'; readonly tool?: string; readonly color?: string; readonly width?: number;
    readonly next?: NextStyles;
}
export interface NextStyles extends FutureFields {
    readonly color?: string; readonly fill?: string; readonly dash?: string; readonly size?: string;
    readonly font?: string; readonly align?: string; readonly textAlign?: string; readonly valign?: string;
    readonly headStart?: string; readonly headEnd?: string; readonly route?: string; readonly spline?: string;
    readonly highlighterColor?: string;
}
export interface ViewRecord extends FutureFields {
    readonly type: 'view'; readonly sheet?: string; readonly x?: number; readonly y?: number; readonly zoom?: number;
    readonly grid?: boolean; readonly focusMode?: boolean; readonly toolLock?: boolean;
    readonly transparent?: boolean; readonly debugMode?: boolean;
}
export interface PaperRecord extends FutureFields {
    readonly type: 'paper'; readonly size?: string; readonly orientation?: string; readonly ruling?: string;
    readonly spacing?: number; readonly margin?: boolean; readonly pages?: number;
}
export interface HostRecord extends FutureFields {
    readonly type: 'host'; readonly pdf: JsonObject;
    readonly pages: readonly (readonly [number, number])[]; // display sizes after rotation, PDF points (R-W5)
}
export interface MediaRecord extends FutureFields {
    readonly type: 'media'; readonly id: MediaId; readonly mime: MediaMime;
    readonly w: number; readonly h: number; readonly bytes: number;
    readonly duration?: number; readonly file?: string | null; readonly animated?: boolean; readonly name?: string;
}
export interface SheetRecord extends FutureFields {
    readonly type: 'sheet'; readonly id: string; readonly name: string; readonly order: string;
}
export interface NodeRecordBase extends FutureFields {
    readonly type: 'node'; readonly id: string; readonly kind: string; readonly parent: string; readonly order: string;
    readonly page?: number; readonly x: number; readonly y: number; readonly rot?: number;
    readonly locked?: boolean; readonly opacity?: number; readonly b: Bounds;
}
export interface OutlineFields {
    readonly color?: string; readonly width: number; readonly dash?: string;
}
export interface LabelFields {
    readonly labelColor: string; readonly fill: string; readonly size: string; readonly font: string;
    readonly label: StoredRichText | null; readonly labelScale?: number;
}
export interface StoredWidthModel extends FutureFields {
    readonly id: string; readonly rMin?: number; readonly rMax?: number;
}
export interface StrokeRecord extends NodeRecordBase, OutlineFields {
    readonly kind: 'stroke'; readonly pts: string; readonly tool: string;
    readonly widthModel: StoredWidthModel; readonly geomVersion: number; readonly fairTol: number;
    readonly closed?: boolean; readonly sx?: number; readonly sy?: number; readonly fill?: string; readonly complete?: boolean;
}
export interface FigureRecord extends NodeRecordBase, OutlineFields, LabelFields {
    readonly kind: 'figure'; readonly shape: string; readonly w: number; readonly h: number; readonly growY: number;
    readonly color: string; readonly dash: string; readonly align: string; readonly valign: string;
    readonly flipX: boolean; readonly flipY: boolean; readonly url: string | null;
}
export interface TextRecord extends NodeRecordBase {
    readonly kind: 'text'; readonly text: StoredRichText; readonly w: number;
    readonly color: string; readonly size: string; readonly font: string; readonly align: string;
    readonly autoSize?: boolean; readonly scale: number;
}
export interface StickyRecord extends NodeRecordBase {
    readonly kind: 'sticky'; readonly text: StoredRichText; readonly color?: string; readonly labelColor?: string;
    readonly size: string; readonly font: string; readonly align: string; readonly valign: string;
    readonly growY: number; readonly fit: number | null; readonly scale: number; readonly url: string | null;
}
export interface StoredAttachment extends FutureFields {
    readonly target: string; readonly anchor: { readonly x: number; readonly y: number; };
    readonly exact: boolean; readonly precise: boolean; readonly snap: string;
}
export interface StoredConnectorEnd extends FutureFields {
    readonly x: number; readonly y: number; readonly attach: StoredAttachment | null;
}
export interface ConnectorRecord extends NodeRecordBase, OutlineFields, LabelFields {
    readonly kind: 'connector'; readonly route: string; readonly color: string; readonly dash: string;
    readonly start: StoredConnectorEnd; readonly end: StoredConnectorEnd; readonly bend: number; readonly elbowMid?: number;
    readonly headStart?: string; readonly headEnd?: string; readonly labelAt?: number;
}
export interface PolylineRecord extends NodeRecordBase, OutlineFields {
    readonly kind: 'polyline'; readonly points: readonly { readonly x: number; readonly y: number; }[];
    readonly spline: string; readonly color: string; readonly dash: string; readonly size: string;
}
export interface FrameRecord extends NodeRecordBase {
    readonly kind: 'frame'; readonly w: number; readonly h: number; readonly name: string; readonly color: string | null;
}
export interface GroupRecord extends NodeRecordBase { readonly kind: 'group'; }
export interface StoredCrop extends FutureFields {
    readonly x0: number; readonly y0: number; readonly x1: number; readonly y1: number; readonly circle: boolean;
}
export interface PictureRecord extends NodeRecordBase {
    readonly kind: 'picture'; readonly w: number; readonly h: number; readonly media: MediaId | null;
    readonly crop: StoredCrop | null; readonly flipX: boolean; readonly flipY: boolean;
    readonly alt: string; readonly inverted: boolean; readonly playing: boolean; readonly url: string | null;
}
export interface ClipRecord extends NodeRecordBase {
    readonly kind: 'clip'; readonly w: number; readonly h: number; readonly media: MediaId | null;
    readonly time: number; readonly playing: boolean; readonly autoplay: boolean; readonly alt: string;
}
export interface StoredLinkPreview extends FutureFields {
    readonly title: string; readonly description: string; readonly image: MediaId | null; readonly favicon: MediaId | null;
}
export interface LinkcardRecord extends NodeRecordBase {
    readonly kind: 'linkcard'; readonly w: number; readonly h: number; readonly url: string;
    readonly preview: StoredLinkPreview | null;
}
export interface EmbedRecord extends NodeRecordBase {
    readonly kind: 'embed'; readonly w: number; readonly h: number; readonly url: string;
}
export interface OpaqueNodeRecord extends NodeRecordBase { readonly kind: 'opaque'; readonly raw: JsonValue; }
export type KnownNodeRecord = StrokeRecord | FigureRecord | TextRecord | StickyRecord | ConnectorRecord
    | PolylineRecord | FrameRecord | GroupRecord | PictureRecord | ClipRecord | LinkcardRecord | EmbedRecord | OpaqueNodeRecord;
export interface EndRecord extends FutureFields { readonly type: 'end'; readonly count: number; }
export type KnownRecord = PenRecord | ViewRecord | PaperRecord | HostRecord | MediaRecord | SheetRecord | KnownNodeRecord | EndRecord;
export type NativeRecord = KnownRecord | JsonObject;

// R-W6/text §4.2: positional defaults are explicit; future trailing elements stay untouched.
export type StoredRun = readonly [string, JsonObject?, ...JsonValue[]];
export type StoredBlock = readonly [string, number, string, readonly StoredRun[], number?, ...JsonValue[]];
export interface StoredRichText extends FutureFields { readonly b: readonly StoredBlock[]; }

// W-D3 supplies bounded raw lexemes. W-D2 must splice unknown values, not stringify them.
// A pdf host's pdf object is opaque even though its field name is known (R-W5).
export interface RawFieldSlice {
    readonly key: string;
    readonly value: string;
    readonly parentPath?: readonly (string | number)[]; // absent = root; nested unknown fields/tuple tails also survive
}
export interface RecordSource {
    readonly line: string;
    readonly unknownFields: readonly RawFieldSlice[];
    readonly opaqueFields?: readonly RawFieldSlice[];
}
export type ValidatedRecord =
    | { readonly category: 'pen'; readonly record: PenRecord; }
    | { readonly category: 'view'; readonly record: ViewRecord; }
    | { readonly category: 'paper'; readonly record: PaperRecord; }
    | { readonly category: 'host'; readonly record: HostRecord; }
    | { readonly category: 'media'; readonly record: MediaRecord; }
    | { readonly category: 'sheet'; readonly record: SheetRecord; }
    | { readonly category: 'node'; readonly record: KnownNodeRecord; readonly unknownKind: false; }
    | { readonly category: 'node'; readonly record: NodeRecordBase; readonly unknownKind: true; }
    | { readonly category: 'opaque'; readonly record: JsonObject; }
    | { readonly category: 'end'; readonly record: EndRecord; };
export interface ValidationRefusal {
    readonly code: 'type' | 'value' | 'range' | 'limit' | 'format';
    readonly field: string;
    readonly reason: string;
    readonly action: 'read-only' | 'repair'; // only model-defined, content-preserving repairs may use the latter
}
export type ValidationResult<T> = { readonly ok: true; readonly value: T; }
    | { readonly ok: false; readonly error: ValidationRefusal; };
export interface RecordContext {
    readonly kind?: BoardFileKind;
    readonly lineBytes?: number;
    readonly recordsBefore?: number;
    readonly sheetsBefore?: number;
    readonly isRoot?: boolean; // parent is a sheet; supplied after the reader resolves the parent table
}

const COMMON_KEYS = ['type', 'id', 'kind', 'parent', 'order', 'page', 'x', 'y', 'rot', 'locked', 'opacity', 'b'] as const;
export const NODE_PROPERTY_ORDER = {
    stroke: ['tool', 'pts', 'widthModel', 'geomVersion', 'fairTol', 'closed', 'width', 'sx', 'sy', 'color', 'fill', 'dash', 'complete'],
    figure: ['shape', 'w', 'h', 'growY', 'color', 'labelColor', 'fill', 'dash', 'size', 'font', 'align', 'valign', 'label', 'width', 'labelScale', 'flipX', 'flipY', 'url'],
    text: ['text', 'color', 'size', 'font', 'align', 'autoSize', 'w', 'scale'],
    sticky: ['text', 'color', 'labelColor', 'size', 'font', 'align', 'valign', 'growY', 'fit', 'scale', 'url'],
    connector: ['route', 'start', 'end', 'bend', 'elbowMid', 'headStart', 'headEnd', 'color', 'labelColor', 'fill', 'dash', 'size', 'font', 'label', 'labelAt', 'width', 'labelScale'],
    polyline: ['points', 'spline', 'color', 'dash', 'size', 'width'],
    frame: ['w', 'h', 'name', 'color'], group: [],
    picture: ['w', 'h', 'media', 'crop', 'flipX', 'flipY', 'alt', 'inverted', 'playing', 'url'],
    clip: ['w', 'h', 'media', 'time', 'playing', 'autoplay', 'alt'],
    linkcard: ['w', 'h', 'url', 'preview'], embed: ['w', 'h', 'url'], opaque: ['raw'],
} as const;
// R-W13: transitional file-only list. W-D3 MUST derive this from model/defaults.ts instead;
// required = a schema property with no default entry. Do not add a second table of default values.
const REQUIRED_NODE_PROPERTIES = {
    stroke: ['tool', 'pts', 'widthModel', 'geomVersion', 'fairTol', 'width'],
    figure: ['shape', 'w', 'h', 'growY', 'color', 'labelColor', 'fill', 'dash', 'size', 'font', 'align', 'valign', 'label', 'width', 'flipX', 'flipY', 'url'],
    text: ['text', 'color', 'size', 'font', 'align', 'w', 'scale'],
    sticky: ['text', 'size', 'font', 'align', 'valign', 'growY', 'fit', 'scale', 'url'],
    connector: ['route', 'start', 'end', 'bend', 'color', 'labelColor', 'fill', 'dash', 'size', 'font', 'label', 'width'],
    polyline: ['points', 'spline', 'color', 'dash', 'size', 'width'],
    frame: ['w', 'h', 'name', 'color'], group: [],
    picture: ['w', 'h', 'media', 'crop', 'flipX', 'flipY', 'alt', 'inverted', 'playing', 'url'],
    clip: ['w', 'h', 'media', 'time', 'playing', 'autoplay', 'alt'],
    linkcard: ['w', 'h', 'url', 'preview'], embed: ['w', 'h', 'url'], opaque: ['raw'],
} as const;
const RECORD_KEYS = {
    pen: ['type', 'tool', 'color', 'width', 'next'],
    view: ['type', 'sheet', 'x', 'y', 'zoom', 'grid', 'focusMode', 'toolLock', 'transparent', 'debugMode'],
    paper: ['type', 'size', 'orientation', 'ruling', 'spacing', 'margin', 'pages'],
    host: ['type', 'pdf', 'pages'], media: ['type', 'id', 'mime', 'w', 'h', 'bytes', 'duration', 'file', 'animated', 'name'],
    sheet: ['type', 'id', 'name', 'order'], end: ['type', 'count'],
} as const;
export const HEADER_KEY_ORDER = ['format', 'version', 'kind', 'fence', 'document'] as const;
export function canonicalHeaderKeys(header: NativeHeader): readonly string[] {
    const known = new Set<string>(HEADER_KEY_ORDER);
    return [...HEADER_KEY_ORDER.filter(key => has(header, key)),
    ...Object.keys(header).filter(key => key !== 'records' && !known.has(key)).sort()];
}

export function knownRecordKeys(record: ValidatedRecord): readonly string[] {
    if (record.category === 'opaque') return [];
    if (record.category === 'node') return record.unknownKind ? COMMON_KEYS
        : [...COMMON_KEYS, ...NODE_PROPERTY_ORDER[record.record.kind as keyof typeof NODE_PROPERTY_ORDER]];
    return RECORD_KEYS[record.category];
}
export function canonicalRecordKeys(record: ValidatedRecord): readonly string[] {
    const known = knownRecordKeys(record);
    const set = new Set(known);
    return [...known.filter(key => has(record.record, key)), ...Object.keys(record.record).filter(key => !set.has(key)).sort()];
}
export function compareRecords(a: ValidatedRecord, b: ValidatedRecord): number {
    const rank = RECORD_ORDER.indexOf(a.category) - RECORD_ORDER.indexOf(b.category);
    if (rank) return rank;
    const left = has(a.record, 'id') && typeof a.record.id === 'string' ? a.record.id : '';
    const right = has(b.record, 'id') && typeof b.record.id === 'string' ? b.record.id : '';
    return left < right ? -1 : left > right ? 1 : 0;
}

class Refusal extends Error {
    constructor(readonly detail: ValidationRefusal) { super(detail.reason); }
}
function refuse(code: ValidationRefusal['code'], field: string, reason: string, action: ValidationRefusal['action'] = 'read-only'): never {
    throw new Refusal({ code, field, reason, action });
}
function result<T>(work: () => T): ValidationResult<T> {
    try { return { ok: true, value: work() }; } catch (error) {
        if (error instanceof Refusal) return { ok: false, error: error.detail };
        return { ok: false, error: { code: 'type', field: '', reason: 'Value is not bounded, parsed JSON data', action: 'read-only' } };
    }
}
function has(value: object, key: string): boolean { return Object.prototype.hasOwnProperty.call(value, key); }
function object(value: unknown, field: string): Record<string, unknown> {
    if (value === null || typeof value !== 'object' || Array.isArray(value)
        || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) refuse('type', field, 'Expected a JSON object');
    return value as Record<string, unknown>;
}
function array(value: unknown, field: string): unknown[] {
    if (!Array.isArray(value)) refuse('type', field, 'Expected an array');
    return value;
}
function string(value: unknown, field: string, max = FORMAT_LIMITS.recordBytes): string {
    if (typeof value !== 'string') refuse('type', field, 'Expected a string');
    if (value.length > max) refuse('limit', field, `String exceeds ${max} UTF-16 units`);
    return value;
}
function number(value: unknown, field: string, min: number = -FORMAT_LIMITS.world, max: number = FORMAT_LIMITS.world,
    repair = false): number {
    if (typeof value !== 'number' || !Number.isFinite(value)) refuse('type', field, 'Expected a finite number');
    if (value < min || value > max) refuse('range', field, `Number must be in ${min}…${max}`, repair ? 'repair' : 'read-only');
    return value;
}
function integer(value: unknown, field: string, min: number, max: number): number {
    const n = number(value, field, min, max);
    if (!Number.isSafeInteger(n)) refuse('value', field, 'Expected a safe integer');
    return n;
}
function id(value: unknown, field: string): string {
    const s = string(value, field, FORMAT_LIMITS.idChars);
    if (s.length === 0 || control(s, 31)) refuse('value', field, 'Identifier is empty or contains a control character', 'repair');
    return s;
}
function mediaId(value: unknown, field: string) {
    const s = string(value, field, 71);
    if (!/^sha256:[0-9a-f]{64}$/u.test(s)) refuse('value', field, 'Expected sha256: plus 64 lowercase hex digits');
}
function order(value: unknown, field: string) {
    const s = string(value, field, 256);
    const head = s.charCodeAt(0);
    const digits = head >= 97 && head <= 122 ? head - 96 : head >= 65 && head <= 90 ? 91 - head : -1;
    if (digits < 1 || s.length < digits + 1 || !/^[A-Za-z][0-9A-Za-z]+$/u.test(s)
        || (s.length > digits + 1 && s.endsWith('0'))) refuse('value', field, 'Invalid fractional order key', 'repair');
}
function requireFields(o: Record<string, unknown>, keys: readonly string[], field: string) {
    for (const key of keys) if (!has(o, key)) refuse('value', `${field}.${key}`, 'Missing required property');
}
function optional(o: Record<string, unknown>, key: string, check: (value: unknown, field: string) => unknown) {
    if (has(o, key)) check(o[key], key);
}
function booleans(o: Record<string, unknown>, keys: readonly string[]) {
    for (const key of keys) optional(o, key, (v, f) => { if (typeof v !== 'boolean') refuse('type', f, 'Expected a boolean'); });
}
function strings(o: Record<string, unknown>, keys: readonly string[]) {
    for (const key of keys) optional(o, key, string);
}
function nullable(o: Record<string, unknown>, key: string, check: (value: unknown, field: string) => unknown) {
    optional(o, key, (v, f) => { if (v !== null) check(v, f); });
}
function dimensions(o: Record<string, unknown>, min = Number.MIN_VALUE, max: number = FORMAT_LIMITS.world) {
    for (const key of ['w', 'h']) number(o[key], key, min, max, true);
}
function url(value: unknown, field: string) {
    const s = string(value, field, 2_048);
    // Validation grants no fetch or activation; the click/preview/embed boundary validates again.
    if (!/^(https?:\/\/|mailto:)/iu.test(s) || control(s, 32)) refuse('value', field, 'Only absolute http, https or mailto links are allowed');
}
function leaf(value: unknown, field: string) {
    const name = string(value, field, 255);
    if (!name || name === '.' || name === '..' || name.includes('/') || name.includes('\\') || name.includes('\0')) refuse('value', field, 'Media file must be one leaf name, not a path or URL');
}
function control(text: string, ceiling: number): boolean {
    for (let i = 0; i < text.length; i++) {
        const c = text.charCodeAt(i);
        if (c <= ceiling || c === 127) return true;
    }
    return false;
}

function json(value: unknown, depthLimit: number = FORMAT_LIMITS.jsonDepth) {
    // Iterative, depth-bounded traversal. Unknown keys stay inert, including __proto__/constructor.
    type Frame = { value: unknown; depth: number; keys?: string[]; index: number; };
    const stack: Frame[] = [{ value, depth: 0, index: -1 }];
    while (stack.length) {
        const frame = stack[stack.length - 1];
        const v = frame.value;
        if (frame.index === -1) {
            if (v === null || typeof v === 'boolean') { stack.pop(); continue; }
            if (typeof v === 'number') { if (!Number.isFinite(v)) refuse('type', '', 'JSON numbers must be finite'); stack.pop(); continue; }
            if (typeof v === 'string') { string(v, ''); stack.pop(); continue; }
            if (frame.depth >= depthLimit) refuse('limit', '', `JSON nesting exceeds ${depthLimit}`);
            if (!Array.isArray(v)) frame.keys = Object.keys(object(v, ''));
            frame.index = 0;
        }
        const items = v as unknown[] | Record<string, unknown>;
        const length = frame.keys ? frame.keys.length : (items as unknown[]).length;
        if (frame.index >= length) { stack.pop(); continue; }
        const key = frame.keys ? frame.keys[frame.index++] : String(frame.index++);
        const descriptor = Object.getOwnPropertyDescriptor(items, key);
        if (!descriptor || !has(descriptor, 'value')) refuse('type', key, 'Expected an own JSON data property');
        stack.push({ value: descriptor.value, depth: frame.depth + 1, index: -1 });
    }
}

function richText(value: unknown, field: string): number {
    const rt = object(value, field);
    const blocks = array(rt.b, `${field}.b`);
    if (blocks.length < 1 || blocks.length > FORMAT_LIMITS.textChars + 1) refuse('limit', field, 'Rich text has an invalid block count');
    let total = blocks.length - 1; // the plain-text projection has a newline between blocks
    for (const entry of blocks) {
        const block = array(entry, field);
        if (block.length < 4) refuse('value', field, 'Rich text block needs kind, level, dir and runs');
        const kind = string(block[0], field);
        const level = integer(block[1], field, 0, 7);
        if (kind === 'p' && level !== 0) refuse('value', field, 'Paragraph level must be zero', 'repair');
        string(block[2], field);
        if (block.length > 4) integer(block[4], field, 1, Number.MAX_SAFE_INTEGER);
        const runs = array(block[3], field);
        if (runs.length < 1 || runs.length > FORMAT_LIMITS.recordBytes) refuse('limit', field, 'Rich text has an invalid run count');
        for (const entry of runs) {
            const run = array(entry, field);
            if (run.length < 1) refuse('value', field, 'Rich text run needs text');
            const text = string(run[0], field, FORMAT_LIMITS.textChars);
            total += text.length;
            if (total > FORMAT_LIMITS.textChars) refuse('limit', field, 'Text exceeds one million UTF-16 units');
            if (text.includes('\n')) refuse('value', field, 'Rich text run contains a paragraph break', 'repair');
            for (let i = 0; i < text.length; i++) {
                const code = text.charCodeAt(i);
                if (code >= 0xd800 && code <= 0xdbff) {
                    const next = text.charCodeAt(++i);
                    if (!(next >= 0xdc00 && next <= 0xdfff)) refuse('value', field, 'Text contains a lone surrogate', 'repair');
                } else if (code >= 0xdc00 && code <= 0xdfff) refuse('value', field, 'Text contains a lone surrogate', 'repair');
            }
            if (run.length > 1) {
                const marks = object(run[1], field);
                for (const key of ['b', 'i', 'u', 's', 'code', 'hl']) optional(marks, key, (v, f) => {
                    if (v !== true) refuse('value', f, 'A present rich-text mark must be true');
                });
                optional(marks, 'link', url);
            }
        }
    }
    json(value, FORMAT_LIMITS.richTextDepth);
    return total;
}
function connectorEnd(value: unknown, field: string) {
    const end = object(value, field);
    requireFields(end, ['x', 'y', 'attach'], field);
    number(end.x, `${field}.x`); number(end.y, `${field}.y`);
    nullable(end, 'attach', (v, f) => {
        const attach = object(v, f), anchor = object(attach.anchor, `${f}.anchor`);
        requireFields(attach, ['target', 'anchor', 'exact', 'precise', 'snap'], f);
        id(attach.target, `${f}.target`);
        number(anchor.x, `${f}.anchor.x`, 0, 1, true); number(anchor.y, `${f}.anchor.y`, 0, 1, true);
        booleans(attach, ['exact', 'precise']); strings(attach, ['snap']);
    });
}
function node(o: Record<string, unknown>, context: RecordContext): ValidatedRecord {
    id(o.id, 'id'); id(o.parent, 'parent'); order(o.order, 'order'); string(o.kind, 'kind', 128);
    number(o.x, 'x'); number(o.y, 'y');
    optional(o, 'page', v => integer(v, 'page', 0, Number.MAX_SAFE_INTEGER));
    if (context.kind === 'whiteboard' || context.isRoot === false) {
        if (has(o, 'page')) refuse('value', 'page', 'Only a paged-board root node carries page');
    } else if (context.kind !== undefined && context.isRoot === true && !has(o, 'page')) {
        refuse('value', 'page', 'Paged-board root node requires page');
    }
    optional(o, 'rot', (v, f) => { const n = number(v, f); if (n < 0 || n >= 2 * Math.PI) refuse('range', f, 'Rotation must be normalized to [0,2π)', 'repair'); });
    optional(o, 'opacity', (v, f) => number(v, f, 0, 1, true)); booleans(o, ['locked']);
    const bounds = array(o.b, 'b');
    if (bounds.length !== 4) refuse('value', 'b', 'Bounds need exactly x,y,w,h');
    number(bounds[0], 'b.x'); number(bounds[1], 'b.y'); number(bounds[2], 'b.w', 0); number(bounds[3], 'b.h', 0);
    const kind = o.kind as string;
    if (!has(NODE_PROPERTY_ORDER, kind)) return { category: 'node', record: o as unknown as NodeRecordBase, unknownKind: true };
    const properties: readonly string[] = NODE_PROPERTY_ORDER[kind as keyof typeof NODE_PROPERTY_ORDER];
    requireFields(o, REQUIRED_NODE_PROPERTIES[kind as keyof typeof REQUIRED_NODE_PROPERTIES], kind);
    strings(o, ['color', 'labelColor', 'fill', 'dash', 'size', 'font', 'align', 'valign']
        .filter(key => properties.includes(key) && !(kind === 'frame' && key === 'color')));
    if (kind === 'stroke' || kind === 'figure' || kind === 'connector' || kind === 'polyline') number(o.width, 'width', 0.05, 500, true);
    if (properties.includes('labelScale')) optional(o, 'labelScale', (v, f) => number(v, f, 0.01, 100, true));
    let textCount = 0;
    if (properties.includes('text') && has(o, 'text')) textCount += richText(o.text, 'text');
    if (properties.includes('label') && has(o, 'label') && o.label !== null) textCount += richText(o.label, 'label');
    if (textCount > FORMAT_LIMITS.textChars) refuse('limit', 'text', 'Combined text exceeds one million UTF-16 units');
    switch (kind) {
        case 'stroke':
            string(o.pts, 'pts', FORMAT_LIMITS.pointsChars);
            strings(o, ['tool']); booleans(o, ['closed', 'complete']);
            for (const key of ['sx', 'sy']) optional(o, key, (v, f) => {
                if (number(v, f, -1_000_000, 1_000_000, true) === 0) refuse('range', f, 'Stroke scale cannot be zero', 'repair');
            });
            optional(o, 'widthModel', (v, f) => {
                const model = object(v, f);
                string(model.id, `${f}.id`);
                if (model.id === 'pressure-linear-v1') {
                    const min = number(model.rMin, `${f}.rMin`, 0, Number.MAX_VALUE);
                    const max = number(model.rMax, `${f}.rMax`, 0, Number.MAX_VALUE);
                    if (max < min) refuse('range', f, 'Width model rMax must be at least rMin');
                }
            });
            optional(o, 'geomVersion', (v, f) => integer(v, f, 0, Number.MAX_SAFE_INTEGER));
            optional(o, 'fairTol', (v, f) => number(v, f, 0));
            break;
        case 'figure':
            string(o.shape, 'shape'); dimensions(o, 1, 1_000_000);
            optional(o, 'growY', (v, f) => number(v, f, 0)); booleans(o, ['flipX', 'flipY']); nullable(o, 'url', url);
            break;
        case 'text':
            if (!has(o, 'text')) refuse('value', 'text', 'Text node requires rich text');
            number(o.w, 'w', 1, 1_000_000, true); booleans(o, ['autoSize']);
            optional(o, 'scale', (v, f) => number(v, f, Number.MIN_VALUE, FORMAT_LIMITS.world, true));
            break;
        case 'sticky':
            if (!has(o, 'text')) refuse('value', 'text', 'Sticky requires rich text');
            optional(o, 'growY', (v, f) => number(v, f, 0));
            nullable(o, 'fit', (v, f) => number(v, f, Number.MIN_VALUE));
            optional(o, 'scale', (v, f) => number(v, f, Number.MIN_VALUE, FORMAT_LIMITS.world, true)); nullable(o, 'url', url);
            break;
        case 'connector':
            connectorEnd(o.start, 'start'); connectorEnd(o.end, 'end');
            strings(o, ['route', 'headStart', 'headEnd']);
            optional(o, 'bend', (v, f) => number(v, f, -1_000_000, 1_000_000, true));
            for (const key of ['elbowMid', 'labelAt']) optional(o, key, (v, f) => number(v, f, 0, 1, true));
            break;
        case 'polyline': {
            const points = array(o.points, 'points');
            if (points.length < 2 || points.length > 5_000) refuse('limit', 'points', 'Polyline needs 2…5,000 handles');
            for (const value of points) { const point = object(value, 'points'); number(point.x, 'points.x'); number(point.y, 'points.y'); }
            strings(o, ['spline']); break;
        }
        case 'frame': dimensions(o); string(o.name, 'name', 1_000); nullable(o, 'color', string); break;
        case 'picture':
            dimensions(o); nullable(o, 'media', mediaId); nullable(o, 'url', url);
            optional(o, 'alt', (v, f) => string(v, f, 10_000)); booleans(o, ['flipX', 'flipY', 'inverted', 'playing']);
            nullable(o, 'crop', (v, f) => {
                const crop = object(v, f);
                requireFields(crop, ['x0', 'y0', 'x1', 'y1', 'circle'], f);
                for (const key of ['x0', 'y0', 'x1', 'y1']) number(crop[key], `${f}.${key}`, 0, 1, true);
                if ((crop.x0 as number) >= (crop.x1 as number) || (crop.y0 as number) >= (crop.y1 as number)) refuse('range', f, 'Crop must have positive dimensions', 'repair');
                booleans(crop, ['circle']);
            }); break;
        case 'clip':
            dimensions(o); nullable(o, 'media', mediaId); optional(o, 'time', (v, f) => number(v, f, 0, Number.MAX_VALUE));
            optional(o, 'alt', (v, f) => string(v, f, FORMAT_LIMITS.textChars)); booleans(o, ['playing', 'autoplay']); break;
        case 'linkcard':
            dimensions(o); url(o.url, 'url');
            nullable(o, 'preview', (v, f) => {
                const preview = object(v, f);
                requireFields(preview, ['title', 'description', 'image', 'favicon'], f);
                const title = string(preview.title, `${f}.title`, FORMAT_LIMITS.textChars);
                const description = string(preview.description, `${f}.description`, FORMAT_LIMITS.textChars);
                if (title.length + description.length > FORMAT_LIMITS.textChars) refuse('limit', f, 'Preview text exceeds one million UTF-16 units');
                nullable(preview, 'image', mediaId); nullable(preview, 'favicon', mediaId);
            }); break;
        case 'embed': dimensions(o); url(o.url, 'url'); break;
        case 'opaque': if (!has(o, 'raw')) refuse('value', 'raw', 'Opaque node needs its original data'); break;
    }
    return { category: 'node', record: o as unknown as KnownNodeRecord, unknownKind: false };
}

export function validateFileBudget(bytes: number): ValidationResult<number> {
    return result(() => integer(bytes, 'fileBytes', 0, FORMAT_LIMITS.fileBytes));
}
export function validateHeader(value: unknown): ValidationResult<{
    readonly header: NativeHeader; readonly access: 'editable' | 'read-only'; readonly newerMinor: boolean;
}> {
    return result(() => {
        const o = object(value, 'header');
        if (o.format !== 'board') refuse('format', 'format', 'Not a native board');
        const version = array(o.version, 'version');
        if (version.length !== 2) refuse('value', 'version', 'Version must be [major,minor]');
        integer(version[0], 'version.major', 1, Number.MAX_SAFE_INTEGER); integer(version[1], 'version.minor', 0, Number.MAX_SAFE_INTEGER);
        if (o.kind !== 'whiteboard' && o.kind !== 'notebook' && o.kind !== 'pdf-ink') refuse('value', 'kind', 'Unknown board kind');
        optional(o, 'fence', string);
        // records are walked separately; a header parsed from an envelope must not trigger a second full traversal.
        for (const key of Object.keys(o)) if (key !== 'records') json(o[key]);
        return {
            header: o as unknown as NativeHeader, access: version[0] === NATIVE_VERSION[0] ? 'editable' : 'read-only',
            newerMinor: version[0] === NATIVE_VERSION[0] && (version[1] as number) > NATIVE_VERSION[1]
        };
    });
}
// Untrusted callers must first use W-D3's lexical preflight, BEFORE JSON.parse. This checks parsed
// data without expanding points/media; context carries the preflight's byte/count observations.
export function validateRecord(value: unknown, context: RecordContext = {}): ValidationResult<ValidatedRecord> {
    return result(() => {
        if (context.lineBytes !== undefined) integer(context.lineBytes, 'lineBytes', 0, FORMAT_LIMITS.recordBytes);
        if (context.recordsBefore !== undefined) integer(context.recordsBefore, 'recordsBefore', 0, FORMAT_LIMITS.records - 1);
        const o = object(value, 'record');
        const type = string(o.type, 'type', 128);
        // Cheap allocation limits precede even the bounded JSON walk. Point decoding is deliberately lazy.
        if (type === 'node' && typeof o.pts === 'string' && o.pts.length > FORMAT_LIMITS.pointsChars) refuse('limit', 'pts', 'Point string exceeds 48 MiB');
        if (type === 'host' && Array.isArray(o.pages) && o.pages.length > FORMAT_LIMITS.pdfPages) refuse('limit', 'pages', 'PDF page count exceeds 65,536');
        let validated: ValidatedRecord;
        switch (type) {
            case 'pen':
                strings(o, ['tool', 'color']); optional(o, 'width', (v, f) => number(v, f, 0.36, 10.5, true));
                optional(o, 'next', (v, f) => strings(object(v, f), ['color', 'fill', 'dash', 'size', 'font', 'align', 'textAlign', 'valign', 'headStart', 'headEnd', 'route', 'spline', 'highlighterColor']));
                validated = { category: type, record: o as unknown as PenRecord }; break;
            case 'view':
                optional(o, 'sheet', id); optional(o, 'x', number); optional(o, 'y', number);
                optional(o, 'zoom', (v, f) => number(v, f, Number.MIN_VALUE));
                booleans(o, ['grid', 'focusMode', 'toolLock', 'transparent', 'debugMode']);
                validated = { category: type, record: o as unknown as ViewRecord }; break;
            case 'paper':
                if (context.kind !== undefined && context.kind !== 'notebook') refuse('value', 'type', 'Paper belongs only to a notebook');
                strings(o, ['size', 'orientation', 'ruling']); optional(o, 'spacing', (v, f) => number(v, f, -Number.MAX_VALUE, Number.MAX_VALUE));
                optional(o, 'pages', (v, f) => number(v, f, -Number.MAX_VALUE, Number.MAX_VALUE)); booleans(o, ['margin']);
                validated = { category: type, record: o as unknown as PaperRecord }; break;
            case 'host': {
                if (context.kind !== undefined && context.kind !== 'pdf-ink') refuse('value', 'type', 'Host belongs only to PDF ink');
                object(o.pdf, 'pdf');
                const pages = array(o.pages, 'pages');
                if (pages.length < 1 || pages.length > FORMAT_LIMITS.pdfPages) refuse('limit', 'pages', 'PDF host needs 1…65,536 pages');
                for (const entry of pages) {
                    const page = array(entry, 'pages');
                    if (page.length !== 2) refuse('value', 'pages', 'Page display size needs [w,h]');
                    number(page[0], 'pages.w', Number.MIN_VALUE, FORMAT_LIMITS.pdfPageSize); number(page[1], 'pages.h', Number.MIN_VALUE, FORMAT_LIMITS.pdfPageSize);
                }
                validated = { category: type, record: o as unknown as HostRecord }; break;
            }
            case 'media':
                mediaId(o.id, 'id');
                if (!MEDIA_MIMES.includes(o.mime as MediaMime)) refuse('value', 'mime', 'Unsupported media MIME type');
                integer(o.w, 'w', 1, FORMAT_LIMITS.world); integer(o.h, 'h', 1, FORMAT_LIMITS.world);
                integer(o.bytes, 'bytes', 0, Number.MAX_SAFE_INTEGER);
                optional(o, 'duration', (v, f) => number(v, f, 0, Number.MAX_VALUE)); nullable(o, 'file', leaf);
                booleans(o, ['animated']); optional(o, 'name', string);
                validated = { category: type, record: o as unknown as MediaRecord }; break;
            case 'sheet': {
                if (context.sheetsBefore !== undefined) integer(context.sheetsBefore, 'sheetsBefore', 0, FORMAT_LIMITS.sheets - 1);
                id(o.id, 'id'); const name = string(o.name, 'name', 200);
                if (!name.trim()) refuse('value', 'name', 'Sheet name must not be blank', 'repair');
                order(o.order, 'order'); validated = { category: type, record: o as unknown as SheetRecord }; break;
            }
            case 'node': validated = node(o, context); break;
            case 'end':
                integer(o.count, 'count', 0, FORMAT_LIMITS.records - 1);
                if (context.recordsBefore !== undefined && o.count !== context.recordsBefore) refuse('value', 'count', 'End count does not match preceding records (truncated or spliced file)');
                validated = { category: type, record: o as unknown as EndRecord }; break;
            default:
                if (has(o, 'id')) id(o.id, 'id');
                validated = { category: 'opaque', record: o as JsonObject };
        }
        json(o);
        return validated;
    });
}
