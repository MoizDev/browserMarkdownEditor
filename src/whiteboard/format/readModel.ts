import { normalizePaper, PAPER_SIZES } from '../../utils/paper';
import type { NotebookPaper } from '../../utils/paper';
import type { BoardKind, HostBlock, Sheet, ViewFlags } from '../model/doc';
import { COMMON_NODE_DEFAULTS, MEDIA_DEFAULTS, NODE_DEFAULTS, UI_DEFAULTS, VIEW_DEFAULTS } from '../model/defaults';
import { isValidId } from '../model/ids';
import type { NodeId, ParentId, SheetId } from '../model/ids';
import type { ExtBag, RawJson } from '../model/json';
import { MEDIA_MIMES } from '../model/media';
import type { MediaEntry, MediaId } from '../model/media';
import type { NodeRecord } from '../model/nodes';
import { isValidKey } from '../model/orderKey';
import type { OrderKey } from '../model/orderKey';
import { ARROWHEADS, DASHES, FIGURE_SHAPES, FILLS, FONTS, H_ALIGNS, SIZES, SWATCHES, TOOLS, V_ALIGNS } from '../model/styles';
import type { UiBlock } from '../model/styles';
import type { Block, Marks, RichText, Run } from '../text/richText';
import { COMPATIBILITY_FENCE, isCompatibilityFence } from './fence';
import { NATIVE_FORMAT_ID } from './identity';
import { JsonReadError, parseJson, parseJsonIncremental } from './jsonRead';
import type { JsonSpan } from './jsonRead';
import { inspectPoints, inspectPointsIncremental } from './points';
import type { PointInspection } from './points';
import { FORMAT_LIMITS, NODE_PROPERTY_ORDER } from './schema';
import type { Bounds } from './schema';
import type { SavedView } from './encode';
import type { ReadIssue, ReadOptions, ReadPosition } from './readTypes';

export interface ModelReadContext {
    readonly options: ReadOptions;
    readonly issue: (issue: ReadIssue) => void;
    readonly position: ReadPosition;
}
export type MappedRecord =
    | { category: 'node'; value: NodeRecord; bounds?: Bounds; pointHeader?: PointInspection['header']; reencode: boolean; }
    | { category: 'sheet'; value: Sheet; reencode: boolean; }
    | { category: 'media'; value: MediaEntry; reencode: boolean; }
    | { category: 'pen'; value: UiBlock; reencode: boolean; }
    | { category: 'view'; value: ViewFlags; savedView?: SavedView; reencode: boolean; }
    | { category: 'paper' | 'host'; value: HostBlock; reencode: boolean; }
    | { category: 'end'; count: number; value: ExtBag | null; reencode: boolean; }
    | { category: 'opaque'; type: string; id: string; value: RawJson; reencode: boolean; };

const COMMON_FIELDS = ['type', 'id', 'kind', 'parent', 'order', 'page', 'x', 'y', 'rot', 'locked', 'opacity', 'b'];
const STROKE_TOOLS = ['pen', 'highlighter'] as const;
const ROUTES = ['arc', 'elbow'] as const;
const SPLINES = ['line', 'cubic'] as const;
const SNAPS = ['none', 'center', 'edge-point', 'edge'] as const;
const DIRECTIONS = ['auto', 'ltr', 'rtl'] as const;
const BLOCKS = ['p', 'ul', 'ol', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6'] as const;
const MARKS = ['b', 'i', 'u', 's', 'code', 'hl', 'link', 'x'];
const NEXT = ['fill', 'dash', 'size', 'font', 'align', 'textAlign', 'valign', 'headStart', 'headEnd', 'route', 'spline', 'highlighterColor'];
const BOOLS = new Set(['closed', 'complete', 'flipX', 'flipY', 'autoSize', 'inverted', 'playing', 'autoplay']);
const NUMBERS = new Set(['width', 'sx', 'sy', 'geomVersion', 'fairTol', 'w', 'h', 'growY', 'scale', 'fit', 'bend', 'elbowMid', 'labelAt', 'labelScale', 'time']);

function fail(reason: string, span?: JsonSpan, limit = false): never {
    throw new JsonReadError(limit ? 'limit' : 'syntax', reason, span?.start ?? 0);
}
function note(context: ModelReadContext, code: ReadIssue['code'], reason: string, readOnly = false): void {
    context.issue({ code, reason, readOnly, position: context.position });
}
function required(fields: ReadonlyMap<string, JsonSpan>, name: string): JsonSpan {
    const span = fields.get(name);
    if (!span) return fail(`Missing required field ${name}`);
    return span;
}
function number(span: JsonSpan, world = false): number {
    const value = span.number();
    if (world && Math.abs(value) > FORMAT_LIMITS.world) fail('World number exceeds ±10^7', span, true);
    return value;
}
function integer(span: JsonSpan, min: number, max: number): number {
    const value = number(span);
    if (!Number.isSafeInteger(value) || value < min || value > max) fail(`Integer is outside ${min}…${max}`, span, true);
    return value;
}
function boolean(span: JsonSpan): boolean {
    if (span.kind !== 'boolean') return fail('Expected a boolean', span);
    return span.value() as boolean;
}
function identifier(span: JsonSpan): string {
    const value = span.string(FORMAT_LIMITS.idChars);
    if (!isValidId(value)) fail('Identifier is empty or contains a control character', span);
    return value;
}
function mediaId(span: JsonSpan): MediaId {
    const value = span.string(71);
    if (!/^sha256:[0-9a-f]{64}$/u.test(value)) fail('Invalid media hash', span);
    return value as MediaId;
}
function url(span: JsonSpan, httpsOnly = false): string {
    const value = span.string(2048);
    for (let i = 0; i < value.length; i++) {
        const code = value.charCodeAt(i);
        if (code < 32 || (code >= 127 && code <= 159)) fail('Control character in URL', span);
    }
    try {
        const parsed = new URL(value);
        if (parsed.username || parsed.password || (httpsOnly ? parsed.protocol !== 'https:'
            : !['http:', 'https:', 'mailto:'].includes(parsed.protocol))) return fail('Unsupported URL', span);
    } catch (error) {
        if (error instanceof JsonReadError) throw error;
        return fail('Invalid absolute URL', span);
    }
    return value;
}
function nullable<T>(span: JsonSpan, read: (span: JsonSpan) => T): T | null {
    return span.kind === 'null' ? null : read(span);
}
async function extras(fields: ReadonlyMap<string, JsonSpan>, known: readonly string[], raw = new Map<string, RawJson>(),
    cooperate?: () => Promise<void>): Promise<ExtBag | null> {
    const additional = new Map<string, RawJson>();
    let count = 0;
    for (const [key, value] of fields) {
        if (!known.includes(key)) additional.set(key, cooperate ? await value.rawIncremental(cooperate) : value.raw());
        if (cooperate && (++count & 255) === 0) await cooperate();
    }
    return additional.size || raw.size ? { fields: additional, raw } : null;
}
function fieldMap(span: JsonSpan, cooperate?: () => Promise<void>): Promise<ReadonlyMap<string, JsonSpan>> {
    return cooperate ? span.fieldMapIncremental(cooperate) : Promise.resolve(span.fieldMap());
}
function hasExtras(fields: ReadonlyMap<string, JsonSpan>, known: readonly string[]): boolean {
    for (const key of fields.keys()) if (!known.includes(key)) return true;
    return false;
}
function swatch(value: string, fallback: string): string {
    if (value.length > 64) return fallback;
    const name = value.toLowerCase();
    const prefix = ['light-', 'pale-', 'dark-'].find(item => name.startsWith(item));
    const base = prefix ? name.slice(prefix.length) : name;
    const variants = (prefix === 'light-' || prefix === 'pale-') ? [`light-${base}`, base] : [base, `light-${base}`];
    return variants.find(item => (SWATCHES as readonly string[]).includes(item)) ?? fallback;
}
function enumeration(span: JsonSpan, allowed: readonly string[], fallback: string, context: ModelReadContext,
    preserve: () => void, colour = false): string {
    const value = span.string(FORMAT_LIMITS.recordBytes);
    if (allowed.includes(value)) return value;
    preserve();
    note(context, 'approximation', colour ? 'A newer colour is shown approximately' : 'A newer style is shown with a known fallback');
    return colour ? swatch(value, fallback) : fallback;
}
async function prefix(span: JsonSpan, count: number, cooperate?: () => Promise<void>): Promise<{ values: JsonSpan[]; tail?: RawJson; }> {
    const values: JsonSpan[] = [];
    const items = cooperate ? span.itemsIncremental(cooperate) : span.items();
    for await (const item of items) {
        if (values.length < count) values.push(item);
        else {
            // A future tuple may have millions of tiny extras. Retain one lexical array, not a
            // span/object per extra; the complete tuple was grammar/depth checked before this walk.
            const text = '[' + span.source.slice(item.start, span.end - 1) + ']';
            const tail = cooperate ? await parseJsonIncremental(text, cooperate) : parseJson(text);
            return { values, tail: cooperate ? await tail.rawIncremental(cooperate) : tail.raw() };
        }
    }
    return { values };
}
function tuple(span: JsonSpan, limit: number): JsonSpan[] {
    span.length(limit); // Guard the allocation below, not merely the completed array.
    return [...span.items()];
}
async function rich(span: JsonSpan, context: ModelReadContext): Promise<{ value: RichText; unknown: boolean; repaired: boolean; }> {
    // The depth check and block count precede every block/run allocation and every JSON.parse of text.
    const cooperate = context.options.cooperate;
    const text = cooperate ? await parseJsonIncremental(span.text(), cooperate, FORMAT_LIMITS.richTextDepth)
        : parseJson(span.text(), FORMAT_LIMITS.richTextDepth);
    const fields = await fieldMap(text, cooperate), sourceBlocks = required(fields, 'b');
    if (cooperate) await sourceBlocks.lengthIncremental(FORMAT_LIMITS.richTextBlocks, cooperate);
    else sourceBlocks.length(FORMAT_LIMITS.richTextBlocks);
    const blocks: Block[] = [];
    let chars = 0, unknown = hasExtras(fields, ['b']), repaired = false;
    const sourceBlockItems = cooperate ? sourceBlocks.itemsIncremental(cooperate) : sourceBlocks.items();
    for await (const sourceBlock of sourceBlockItems) {
        const blockTuple = await prefix(sourceBlock, 5, cooperate), values = blockTuple.values;
        if (values.length < 4) fail('Rich block needs kind, level, direction and runs', sourceBlock);
        const kind = enumeration(values[0], BLOCKS, 'p', context, () => { unknown = true; });
        const level = number(values[1]);
        const dir = enumeration(values[2], DIRECTIONS, DIRECTIONS[0], context, () => { unknown = true; });
        const runs: Run[] = [];
        let firstEmpty: Run | undefined, sourceRunCount = 0, firstEmptyUnknown = false, discardedEmptyUnknown = false;
        const sourceRuns = cooperate ? values[3].itemsIncremental(cooperate) : values[3].items();
        for await (const sourceRun of sourceRuns) {
            sourceRunCount++;
            const runTuple = await prefix(sourceRun, 2, cooperate), run = runTuple.values;
            if (!run.length) fail('Rich run needs text', sourceRun);
            const length = run[0].stringLength(FORMAT_LIMITS.textChars);
            chars += length;
            if (chars + blocks.length > FORMAT_LIMITS.textChars) fail('Text exceeds one million UTF-16 units', run[0], true);
            const markFields = run[1] ? await fieldMap(run[1], cooperate) : undefined;
            const hasUnknownMarks = markFields ? hasExtras(markFields, MARKS) : false;
            unknown ||= hasUnknownMarks;
            const marks: Record<string, unknown> = {};
            if (markFields) {
                for (const key of MARKS) {
                    const value = markFields.get(key);
                    if (!value) continue;
                    if (key === 'x') marks.x = cooperate ? await value.rawIncremental(cooperate) : value.raw();
                    else if (key === 'link') marks.link = url(value);
                    else {
                        if (value.kind !== 'boolean' || value.value() !== true) fail('Present rich marks must be true', value);
                        marks[key] = true;
                    }
                }
            }
            const extra = runTuple.tail;
            const original = cooperate ? await run[0].stringIncremental(FORMAT_LIMITS.textChars, cooperate) : run[0].string(FORMAT_LIMITS.textChars);
            const clean = original.replace(/[\ud800-\udfff]/gu, '\ufffd');
            if (clean !== original) repaired = true;
            if (clean.includes('\n')) fail('Rich run contains a paragraph break', run[0]);
            const value: Run = { text: clean, marks: marks as Marks, ...(extra === undefined ? {} : { tail: extra }) };
            if (!length) {
                const carriesUnknown = hasUnknownMarks || extra !== undefined || marks.x !== undefined;
                if (firstEmpty === undefined) { firstEmpty = value; firstEmptyUnknown = carriesUnknown; }
                else discardedEmptyUnknown ||= carriesUnknown;
            } else runs.push(value);
        }
        if (!sourceRunCount) fail('Rich block needs at least one run', values[3]);
        // R-W30: empty runs carry no text. Unknown content on an omitted empty run cannot be thrown
        // away; decline that record instead of pretending the repair was lossless.
        if (discardedEmptyUnknown || (runs.length > 0 && firstEmptyUnknown)) fail('An empty run contains unknown content that cannot be removed losslessly', values[3]);
        if (!runs.length) runs.push(firstEmpty!);
        if (runs.length !== sourceRunCount) { repaired = true; note(context, 'repair', 'Removed empty rich-text runs'); }
        if (runs.length > chars + blocks.length + 1) fail('Rich run expansion exceeds text plus blocks', values[3], true);
        const start = values[4] === undefined ? undefined : number(values[4]);
        const extra = blockTuple.tail;
        blocks.push({
            kind: kind as Block['kind'], level, dir: dir as Block['dir'], runs,
            ...(start === undefined ? {} : { start }), ...(extra === undefined ? {} : { tail: extra })
        });
    }
    if (!blocks.length) fail('Rich text needs at least one block', sourceBlocks);
    if (repaired) note(context, 'repair', 'Normalized rich text while retaining its unknown content');
    return { value: { blocks }, unknown, repaired };
}
function endpoint(span: JsonSpan, context: ModelReadContext): { value: unknown; unknown: boolean; } {
    const fields = span.fieldMap();
    let unknown = hasExtras(fields, ['x', 'y', 'attach']);
    const attached = required(fields, 'attach');
    let attach: unknown = null;
    if (attached.kind !== 'null') {
        const a = attached.fieldMap(), anchor = required(a, 'anchor').fieldMap();
        unknown ||= hasExtras(a, ['target', 'anchor', 'exact', 'precise', 'snap']) || hasExtras(anchor, ['x', 'y']);
        attach = {
            target: identifier(required(a, 'target')) as NodeId,
            anchor: { x: number(required(anchor, 'x'), true), y: number(required(anchor, 'y'), true) },
            exact: boolean(required(a, 'exact')), precise: boolean(required(a, 'precise')),
            snap: enumeration(required(a, 'snap'), SNAPS, SNAPS[0], context, () => { unknown = true; }),
        };
    }
    return { value: { x: number(required(fields, 'x'), true), y: number(required(fields, 'y'), true), attach }, unknown };
}
function bounds(fields: ReadonlyMap<string, JsonSpan>, context: ModelReadContext): Bounds | undefined {
    const span = fields.get('b');
    if (span) {
        try {
            const items = tuple(span, 4);
            if (items.length === 4) {
                const value = items.map(item => number(item, true));
                if (value[2] >= 0 && value[3] >= 0) return value as unknown as Bounds;
            }
        } catch (error) { if (!(error instanceof JsonReadError)) throw error; }
    }
    note(context, 'bounds', 'Missing or invalid bounds cache; the scene computes it when needed');
    return undefined;
}
async function node(root: JsonSpan, fields: ReadonlyMap<string, JsonSpan>, context: ModelReadContext): Promise<MappedRecord> {
    const nodeKind = required(fields, 'kind').string(FORMAT_LIMITS.idChars);
    const raw = new Map<string, RawJson>();
    const value: Record<string, unknown> = {
        id: identifier(required(fields, 'id')) as NodeId,
        kind: nodeKind,
        parent: identifier(required(fields, 'parent')) as ParentId,
        order: required(fields, 'order').string(256) as OrderKey,
        page: fields.has('page') ? number(fields.get('page')!) : -1,
        x: number(required(fields, 'x'), true), y: number(required(fields, 'y'), true),
        rotation: fields.has('rot') ? number(fields.get('rot')!) : COMMON_NODE_DEFAULTS.rotation,
        locked: fields.has('locked') ? boolean(fields.get('locked')!) : COMMON_NODE_DEFAULTS.locked,
        opacity: fields.has('opacity') ? number(fields.get('opacity')!) : COMMON_NODE_DEFAULTS.opacity,
        ext: null,
    };
    if (!isValidKey(value.order as string)) note(context, 'repair', 'Order key needs model repair');
    const cachedBounds = bounds(fields, context);
    if (!Object.hasOwn(NODE_PROPERTY_ORDER, nodeKind) || nodeKind === 'opaque') {
        note(context, 'approximation', 'An unknown node is retained as a locked placeholder');
        return {
            category: 'node', value: { ...value, kind: 'opaque', locked: true, raw: root.raw() } as unknown as NodeRecord,
            bounds: cachedBounds, reencode: false
        };
    }
    const knownKind = nodeKind as keyof typeof NODE_PROPERTY_ORDER;
    const defaults = NODE_DEFAULTS[knownKind] as Readonly<Record<string, unknown>>;
    let points: { pts: string; inspection: PointInspection; } | undefined;
    let repaired = false;
    for (const key of NODE_PROPERTY_ORDER[knownKind]) {
        const span = fields.get(key);
        if (!span) {
            if (Object.hasOwn(defaults, key)) { value[key] = defaults[key]; continue; }
            fail(`Missing required ${nodeKind}.${key}`, root);
        }
        const keep = () => { raw.set(key, span.raw()); };
        if (key === 'pts') {
            const pts = context.options.cooperate
                ? await span.stringIncremental(FORMAT_LIMITS.pointsChars, context.options.cooperate) : span.string(FORMAT_LIMITS.pointsChars);
            const inspected = context.options.cooperate
                ? await inspectPointsIncremental(pts, context.options.cooperate) : inspectPoints(pts);
            if (!inspected.ok) {
                note(context, 'points', inspected.error.reason, true);
                return {
                    category: 'node', value: { ...value, kind: 'opaque', locked: true, raw: root.raw() } as unknown as NodeRecord,
                    bounds: cachedBounds, reencode: false
                };
            }
            points = { pts, inspection: inspected.value };
            value.pressure = inspected.value.header.hasPressure ? 'real' : 'none';
        } else if (key === 'text' || key === 'label') {
            if (key === 'label' && span.kind === 'null') value[key] = null;
            else {
                const text = await rich(span, context);
                value[key] = text.value;
                if (text.unknown) keep();
                repaired ||= text.repaired;
            }
        } else if (key === 'start' || key === 'end') {
            const result = endpoint(span, context); value[key] = result.value; if (result.unknown) keep();
        } else if (key === 'widthModel') {
            const model = span.fieldMap(), id = required(model, 'id').string(128);
            if (id === 'uniform') {
                value.widthModel = { id };
                if (hasExtras(model, ['id'])) keep();
            } else if (id === 'pressure-linear-v1') {
                value.widthModel = { id, rMin: number(required(model, 'rMin'), true), rMax: number(required(model, 'rMax'), true) };
                if (hasExtras(model, ['id', 'rMin', 'rMax'])) keep();
            } else { value.widthModel = { id: 'uniform' }; keep(); note(context, 'approximation', 'A newer width model is retained'); }
        } else if (key === 'crop') {
            if (span.kind === 'null') value.crop = null;
            else {
                const crop = span.fieldMap();
                value.crop = {
                    x0: number(required(crop, 'x0')), y0: number(required(crop, 'y0')),
                    x1: number(required(crop, 'x1')), y1: number(required(crop, 'y1')), circle: boolean(required(crop, 'circle'))
                };
                if (hasExtras(crop, ['x0', 'y0', 'x1', 'y1', 'circle'])) keep();
            }
        } else if (key === 'preview') {
            if (span.kind === 'null') value.preview = null;
            else {
                const preview = span.fieldMap();
                value.preview = {
                    title: required(preview, 'title').string(1000), description: required(preview, 'description').string(10000),
                    image: nullable(required(preview, 'image'), mediaId), favicon: nullable(required(preview, 'favicon'), mediaId)
                };
                if (hasExtras(preview, ['title', 'description', 'image', 'favicon'])) keep();
            }
        } else if (key === 'points') {
            span.length(5000);
            const handles: { x: number; y: number; }[] = [];
            for (const handle of span.items()) {
                const coordinates = handle.fieldMap();
                handles.push({ x: number(required(coordinates, 'x'), true), y: number(required(coordinates, 'y'), true) });
                if (hasExtras(coordinates, ['x', 'y'])) keep();
            }
            value.points = handles;
        } else if (key === 'media') value.media = nullable(span, mediaId);
        else if (key === 'url') value.url = nullable(span, item => url(item, knownKind === 'embed'));
        else if (key === 'name') value.name = span.string(1000);
        else if (key === 'alt') value.alt = span.string(10000);
        else if (BOOLS.has(key)) value[key] = boolean(span);
        else if (NUMBERS.has(key)) value[key] = key === 'fit' && span.kind === 'null' ? null : number(span);
        else {
            let allowed: readonly string[], fallback: string;
            switch (key) {
                case 'color': case 'labelColor':
                    if (key === 'color' && nodeKind === 'frame' && span.kind === 'null') { value.color = null; continue; }
                    allowed = SWATCHES; fallback = (defaults[key] as string | undefined) ?? (key === 'labelColor' ? NODE_DEFAULTS.stroke.color : UI_DEFAULTS.next.color); break;
                case 'fill': allowed = FILLS; fallback = UI_DEFAULTS.next.fill; break;
                case 'dash': allowed = DASHES; fallback = UI_DEFAULTS.next.dash; break;
                case 'size': allowed = SIZES; fallback = UI_DEFAULTS.next.size; break;
                case 'font': allowed = FONTS; fallback = UI_DEFAULTS.next.font; break;
                case 'align': allowed = knownKind === 'text' ? V_ALIGNS : H_ALIGNS; fallback = knownKind === 'text' ? UI_DEFAULTS.next.textAlign : UI_DEFAULTS.next.align; break;
                case 'valign': allowed = V_ALIGNS; fallback = UI_DEFAULTS.next.valign; break;
                case 'headStart': case 'headEnd': allowed = ARROWHEADS; fallback = NODE_DEFAULTS.connector[key]; break;
                case 'shape': allowed = FIGURE_SHAPES; fallback = 'rectangle'; break;
                case 'route': allowed = ROUTES; fallback = UI_DEFAULTS.next.route; break;
                case 'spline': allowed = SPLINES; fallback = UI_DEFAULTS.next.spline; break;
                case 'tool': allowed = STROKE_TOOLS; fallback = UI_DEFAULTS.tool; break;
                default: return fail(`Unknown schema field ${key}`, span);
            }
            value[key] = enumeration(span, allowed, fallback, context, keep, key === 'color' || key === 'labelColor');
        }
    }
    value.ext = await extras(fields, [...COMMON_FIELDS, ...NODE_PROPERTY_ORDER[knownKind]], raw, context.options.cooperate);
    if (points) {
        const ref = context.options.admitEncoded(points.pts, points.inspection.header);
        if (!Number.isSafeInteger(ref) || ref < 0) throw new Error('Sample admission returned an invalid reference');
        value.samples = ref;
    }
    return { category: 'node', value: value as unknown as NodeRecord, bounds: cachedBounds, pointHeader: points?.inspection.header, reencode: repaired };
}

export async function readHeader(root: JsonSpan, cooperate?: () => Promise<void>): Promise<{ kind: BoardKind; version: readonly [number, number]; fields: Map<string, RawJson>; fenceValid: boolean; }> {
    const fields = await fieldMap(root, cooperate);
    if (required(fields, 'format').string(128) !== NATIVE_FORMAT_ID) fail('Not native board content', root);
    const version = tuple(required(fields, 'version'), 2);
    if (version.length !== 2) fail('Version must be [major,minor]', root);
    const major = integer(version[0], 1, Number.MAX_SAFE_INTEGER), minor = integer(version[1], 0, Number.MAX_SAFE_INTEGER);
    const kind = required(fields, 'kind').string(128);
    if (kind !== 'whiteboard' && kind !== 'notebook' && kind !== 'pdf-ink') fail('Unknown native board kind', root);
    const document = fields.get('document'), label = fields.get('fence');
    let fenceValid = kind === 'pdf-ink' && !document && !label;
    if (document?.kind === 'object' && label?.kind === 'string') {
        const d = document.fieldMap(), schema = d.get('schema'), store = d.get('store');
        if (d.size === 2 && schema?.kind === 'object' && store?.kind === 'object') {
            const s = schema.fieldMap();
            const emptyStore = store.fields()[Symbol.iterator]().next().done;
            if (s.size === 1 && s.get('schemaVersion')?.kind === 'number' && emptyStore) {
                fenceValid = label.stringLength(FORMAT_LIMITS.recordBytes) === COMPATIBILITY_FENCE.length
                    && isCompatibilityFence({ document: document.value(), fence: label.string(COMPATIBILITY_FENCE.length) });
            }
        }
    }
    const preserved = new Map<string, RawJson>();
    let count = 0;
    for (const [name, value] of fields) {
        if (!['format', 'version', 'kind', 'document', 'fence', 'records'].includes(name)) {
            preserved.set(name, cooperate ? await value.rawIncremental(cooperate) : value.raw());
        }
        if (cooperate && (++count & 255) === 0) await cooperate();
    }
    return { kind, version: [major, minor], fields: preserved, fenceValid };
}
export async function readRecord(root: JsonSpan, kind: BoardKind, context: ModelReadContext): Promise<MappedRecord> {
    const fields = await fieldMap(root, context.options.cooperate), type = required(fields, 'type').string(128);
    switch (type) {
        case 'node': return node(root, fields, context);
        case 'sheet': return {
            category: 'sheet', reencode: false, value: {
                id: identifier(required(fields, 'id')) as SheetId, name: required(fields, 'name').string(200),
                order: required(fields, 'order').string(256) as OrderKey, ext: await extras(fields, ['type', 'id', 'name', 'order'], undefined, context.options.cooperate),
            }
        };
        case 'media': {
            const id = mediaId(required(fields, 'id')), mime = required(fields, 'mime').string(128);
            if (!(MEDIA_MIMES as readonly string[]).includes(mime)) fail('Unsupported media MIME', root);
            const raw = new Map<string, RawJson>(), video = mime.startsWith('video/');
            const duration = fields.get('duration');
            if (!video && duration) raw.set('duration', duration.raw());
            const file = fields.get('file');
            const name = file && file.kind !== 'null' ? file.string(255) : null;
            if (name !== null && (!name || name === '.' || name === '..' || name.includes('/') || name.includes('\\') || name.includes('\0'))) fail('Media file must be one leaf name', file);
            const videoDuration = video ? number(required(fields, 'duration')) : null;
            if (videoDuration !== null && videoDuration < 0) fail('Video duration must be nonnegative', duration);
            return {
                category: 'media', reencode: false, value: {
                    id, mime: mime as MediaEntry['mime'],
                    bytes: integer(required(fields, 'bytes'), 0, Number.MAX_SAFE_INTEGER), w: number(required(fields, 'w'), true), h: number(required(fields, 'h'), true),
                    duration: videoDuration,
                    file: file ? name : MEDIA_DEFAULTS.file, animated: fields.has('animated') ? boolean(fields.get('animated')!) : MEDIA_DEFAULTS.animated,
                    name: fields.has('name') ? fields.get('name')!.string(10000) : MEDIA_DEFAULTS.name,
                    ext: await extras(fields, ['type', 'id', 'mime', 'w', 'h', 'bytes', 'duration', 'file', 'animated', 'name'], raw, context.options.cooperate),
                }
            };
        }
        case 'pen': {
            const raw = new Map<string, RawJson>(), next = { ...UI_DEFAULTS.next } as Record<string, unknown>;
            const sourceNext = fields.get('next')?.fieldMap();
            if (sourceNext) {
                if (hasExtras(sourceNext, NEXT)) raw.set('next', fields.get('next')!.raw());
                for (const key of NEXT) {
                    const span = sourceNext.get(key); if (!span) continue;
                    const choices: readonly string[] = key === 'fill' ? FILLS : key === 'dash' ? DASHES : key === 'size' ? SIZES : key === 'font' ? FONTS
                        : key === 'align' ? H_ALIGNS : key === 'valign' || key === 'textAlign' ? V_ALIGNS
                            : key === 'headStart' || key === 'headEnd' ? ARROWHEADS : key === 'route' ? ROUTES : key === 'spline' ? SPLINES : SWATCHES;
                    next[key] = enumeration(span, choices, String(UI_DEFAULTS.next[key as keyof typeof UI_DEFAULTS.next]), context,
                        () => { raw.set('next', fields.get('next')!.raw()); }, key === 'highlighterColor');
                }
            }
            if (fields.has('color')) next.color = enumeration(fields.get('color')!, SWATCHES, UI_DEFAULTS.next.color, context,
                () => { raw.set('color', fields.get('color')!.raw()); }, true);
            const tool = fields.has('tool') ? enumeration(fields.get('tool')!, TOOLS, UI_DEFAULTS.tool, context,
                () => { raw.set('tool', fields.get('tool')!.raw()); }) : UI_DEFAULTS.tool;
            return {
                category: 'pen', reencode: false, value: {
                    tool: tool as UiBlock['tool'], next: next as unknown as UiBlock['next'],
                    penWidth: fields.has('width') ? number(fields.get('width')!) : UI_DEFAULTS.penWidth,
                    ext: await extras(fields, ['type', 'tool', 'color', 'width', 'next'], raw, context.options.cooperate)
                }
            };
        }
        case 'view': {
            const value = { ...VIEW_DEFAULTS } as unknown as Record<string, unknown>;
            for (const key of ['grid', 'focusMode', 'toolLock', 'transparent', 'debugMode']) if (fields.has(key)) value[key] = boolean(fields.get(key)!);
            value.ext = await extras(fields, ['type', 'sheet', 'x', 'y', 'zoom', 'grid', 'focusMode', 'toolLock', 'transparent', 'debugMode'], undefined, context.options.cooperate);
            let savedView: SavedView | undefined;
            if (['sheet', 'x', 'y', 'zoom'].every(key => fields.has(key))) savedView = {
                sheet: identifier(fields.get('sheet')!), x: number(fields.get('x')!, true), y: number(fields.get('y')!, true), zoom: number(fields.get('zoom')!),
            };
            return { category: 'view', value: value as unknown as ViewFlags, savedView, reencode: false };
        }
        case 'paper': {
            if (kind !== 'notebook') fail('Paper record is only valid in a notebook', root);
            const raw = new Map<string, RawJson>(), paper: Partial<NotebookPaper> = {};
            for (const key of ['size', 'orientation', 'ruling'] as const) {
                const span = fields.get(key); if (!span) continue;
                const value = span.string(FORMAT_LIMITS.recordBytes);
                const valid = key === 'size' ? Object.hasOwn(PAPER_SIZES, value) : key === 'orientation' ? ['portrait', 'landscape'].includes(value) : ['lined', 'grid', 'dotted', 'blank'].includes(value);
                if (valid) (paper as Record<string, unknown>)[key] = value;
                else { raw.set(key, span.raw()); note(context, 'approximation', 'A newer paper setting is shown with a known fallback'); }
            }
            if (fields.has('spacing')) paper.spacing = number(fields.get('spacing')!);
            if (fields.has('margin')) paper.margin = boolean(fields.get('margin')!);
            if (fields.has('pages')) paper.pageCount = number(fields.get('pages')!);
            return {
                category: 'paper', reencode: false, value: {
                    kind: 'notebook', paper: normalizePaper(paper),
                    ext: await extras(fields, ['type', 'size', 'orientation', 'ruling', 'spacing', 'margin', 'pages'], raw, context.options.cooperate)
                }
            };
        }
        case 'host': {
            if (kind !== 'pdf-ink') fail('Host record is only valid on PDF ink', root);
            const pdf = required(fields, 'pdf'); if (pdf.kind !== 'object') fail('PDF bookkeeping must be opaque object data', pdf);
            const sourcePages = required(fields, 'pages'); sourcePages.length(FORMAT_LIMITS.pdfPages);
            const pages: (readonly [number, number])[] = [];
            for (const page of sourcePages.items()) {
                const size = tuple(page, 2); if (size.length !== 2) fail('PDF display size needs [w,h]', page);
                const w = number(size[0]), h = number(size[1]);
                if (w <= 0 || h <= 0 || w > FORMAT_LIMITS.pdfPageSize || h > FORMAT_LIMITS.pdfPageSize) fail('PDF display size is outside 0…14,400 points', page, true);
                pages.push([w, h]);
            }
            if (!pages.length) fail('PDF host needs at least one page', sourcePages);
            return { category: 'host', reencode: false, value: { kind: 'pdf-ink', pdf: context.options.cooperate ? await pdf.rawIncremental(context.options.cooperate) : pdf.raw(), pages, ext: await extras(fields, ['type', 'pdf', 'pages'], undefined, context.options.cooperate) } };
        }
        case 'end': return {
            category: 'end', count: integer(required(fields, 'count'), 0, FORMAT_LIMITS.records - 1),
            value: await extras(fields, ['type', 'count'], undefined, context.options.cooperate), reencode: false
        };
        default: return { category: 'opaque', type, id: identifier(required(fields, 'id')), value: root.raw(), reencode: false };
    }
}
