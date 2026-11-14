import type { BoardDoc, BoardKind, HostBlock, PreservedBlock, Sheet, ViewFlags } from '../model/doc';
import { COMMON_NODE_DEFAULTS, MEDIA_DEFAULTS, NODE_DEFAULTS, UI_DEFAULTS, VIEW_DEFAULTS } from '../model/defaults';
import { NODE_FILE_FIELDS, PAPER_FILE_FIELDS, PEN_FILE_FIELDS } from '../model/fileFields';
import type { ExtBag } from '../model/json';
import type { NodeId, SheetId } from '../model/ids';
import type { MediaEntry, MediaId } from '../model/media';
import type { Node, StrokeNode } from '../model/nodes';
import type { UiBlock } from '../model/styles';
import type { RichText } from '../text/richText';
import { COMPATIBILITY_FENCE, fenceDocument } from './fence';
import { decodePoints, encodePoints, pointExponent, POINT_LIMITS } from './points';
import type { PointHeader, PointSamples } from './points';
import { FORMAT_LIMITS, NATIVE_VERSION, NODE_PROPERTY_ORDER } from './schema';
import type { Bounds } from './schema';
import { compactRaw, guardWrite, jsonText, lazyValue, objectValue, rawValue, refuseWrite, tupleValue } from './writeJson';
import type { EncodedRecord, RecordIdentity, WriteResult } from './writeTypes';

export interface SavedView { readonly sheet: string; readonly x: number; readonly y: number; readonly zoom: number; }
export interface EncoderContext {
    readonly bounds: (node: Node) => Bounds;
    readonly zMax: number; // Host's maximum CSS-px/world-unit scale, before the stroke's own sx/sy.
    readonly stroke: (node: StrokeNode) => PointSamples; // Stroke-local, pinned SampleStoreReader values; requested only on cache miss.
    readonly readEncoded: (node: StrokeNode) => { readonly pts: string; readonly header: PointHeader; } | null; // R-W34: native admission only, not authored quantization.
    readonly savedView: () => SavedView | undefined;
    // R-W22/25: the pinned model owns these indices; a save never scans nodes or RawJson values.
    readonly mediaRefs: ReadonlyMap<MediaId, ReadonlySet<NodeId>>;
    readonly preservedMediaRefs: ReadonlyMap<MediaId, number>;
}

type Field = readonly [name: string, value: unknown];
function mediaReferenced(id: MediaId, context: EncoderContext): boolean {
    return !!context.mediaRefs.get(id)?.size || (context.preservedMediaRefs.get(id) ?? 0) > 0;
}
function omitted(value: unknown, defaults: object, key: string): unknown {
    return Object.prototype.hasOwnProperty.call(defaults, key)
        && value === (defaults as Readonly<Record<string, unknown>>)[key] ? undefined : value;
}
function angle(value: number): number {
    if (!Number.isFinite(value)) refuseWrite('invalid', 'Cannot write a non-finite rotation', 'rotation');
    const turn = 2 * Math.PI;
    let normalized = value % turn;
    if (normalized < 0) normalized += turn;
    // A negative subnormal can round up to a whole turn when added to 2π.
    return normalized === 0 || normalized >= turn ? 0 : normalized;
}
function marks(value: RichText['blocks'][number]['runs'][number]['marks']): unknown {
    return objectValue([
        ...['b', 'i', 'u', 's', 'code', 'hl', 'link'].map(key => [key, value[key as keyof typeof value]] as Field),
        ['x', value.x === undefined ? undefined : rawValue(value.x)],
    ]);
}
function richText(value: RichText): unknown {
    if (!value.blocks.length || value.blocks.length > FORMAT_LIMITS.richTextBlocks) refuseWrite('limit', 'Rich text needs a bounded, nonempty block list');
    let chars = value.blocks.length - 1;
    const blocks = value.blocks.map(block => {
        if (!block.runs.length || block.runs.length > FORMAT_LIMITS.recordBytes / 2) refuseWrite('limit', 'Rich text needs a bounded, nonempty run list');
        const runs = block.runs.map(run => {
            chars += run.text.length;
            if (chars > FORMAT_LIMITS.textChars) refuseWrite('limit', 'Text exceeds one million UTF-16 units');
            if (run.text.includes('\n')) refuseWrite('invalid', 'Rich text run contains a paragraph break');
            for (let i = 0; i < run.text.length; i++) {
                const code = run.text.charCodeAt(i);
                if (code >= 0xd800 && code <= 0xdbff) {
                    const next = run.text.charCodeAt(++i);
                    if (!(next >= 0xdc00 && next <= 0xdfff)) refuseWrite('invalid', 'Rich text contains a lone surrogate');
                } else if (code >= 0xdc00 && code <= 0xdfff) refuseWrite('invalid', 'Rich text contains a lone surrogate');
            }
            const items: unknown[] = [run.text];
            // An unknown run tail starts after the optional marks slot, so keep that slot explicit.
            const hasTail = run.tail !== undefined && compactRaw(run.tail) !== '[]';
            if (Object.keys(run.marks).length || hasTail) items.push(marks(run.marks));
            return tupleValue(items, run.tail);
        });
        const items: unknown[] = [block.kind, block.level, block.dir, runs];
        if (block.start !== undefined) items.push(block.start);
        else if (block.tail !== undefined && compactRaw(block.tail) !== '[]') refuseWrite('invalid', 'A block tail needs an explicit source start slot');
        return tupleValue(items, block.tail);
    });
    return objectValue([['b', blocks]]);
}
function connectorEnd(value: Extract<Node, { kind: 'connector'; }>['start']): unknown {
    const attachment = value.attach === null ? null : objectValue([
        ['target', value.attach.target], ['anchor', objectValue([['x', value.attach.anchor.x], ['y', value.attach.anchor.y]])],
        ['exact', value.attach.exact], ['precise', value.attach.precise], ['snap', value.attach.snap],
    ]);
    return objectValue([['x', value.x], ['y', value.y], ['attach', attachment]]);
}
function nodeProperty(node: Node, key: string, context: EncoderContext): unknown {
    if (key === 'pts' && node.kind === 'stroke') {
        return lazyValue(() => {
            const required = pointExponent(context.zMax, node.sx, node.sy);
            if (!required.ok) refuseWrite('points', required.error.reason, 'samples');
            const native = context.readEncoded(node);
            if (native) {
                const header = native.header;
                if (!Number.isSafeInteger(header.count) || header.count < 1 || header.count > POINT_LIMITS.count
                    || !Number.isInteger(header.k) || header.k < 0 || header.k > POINT_LIMITS.exponent
                    || !Number.isSafeInteger(header.runCount) || header.runCount < 0 || header.runCount > header.count
                    || typeof header.hasPressure !== 'boolean' || header.hasPressure !== (node.pressure === 'real')
                    || typeof native.pts !== 'string' || native.pts.length > POINT_LIMITS.encodedChars) {
                    refuseWrite('points', 'Native payload metadata does not match the stroke');
                }
                if (header.k >= required.value) return native.pts;
            }
            // An admitted native payload may need finer quantization after scaling. Decode that
            // original, not the store's translated runs: opaque channels and explicit run boundaries
            // still belong to the file even though the current renderer does not understand them.
            let samples: PointSamples;
            if (native) {
                const decoded = decodePoints(native.pts);
                if (!decoded.ok) refuseWrite('points', decoded.error.reason, 'samples');
                samples = decoded.value;
            } else samples = context.stroke(node);
            if (node.pressure === 'real' && samples.pressure == null) refuseWrite('points', 'Pressure-real stroke is missing its pressure channel');
            if (node.pressure === 'none' && samples.pressure != null) refuseWrite('points', 'Pressure-none stroke must not acquire a pressure channel');
            const encoded = encodePoints(samples, required.value);
            if (!encoded.ok) refuseWrite('points', encoded.error.reason, 'samples');
            return encoded.value.pts;
        });
    }
    const value = (node as unknown as Readonly<Record<string, unknown>>)[key];
    if (key === 'text' || key === 'label') return value === null ? null : lazyValue(() => richText(value as RichText));
    if (node.kind === 'connector' && (key === 'start' || key === 'end')) return connectorEnd(node[key]);
    if (node.kind === 'stroke' && key === 'widthModel') {
        const model = node.widthModel;
        return model.id === 'uniform' ? objectValue([['id', model.id]])
            : objectValue([['id', model.id], ['rMin', model.rMin], ['rMax', model.rMax]]);
    }
    if (node.kind === 'polyline' && key === 'points') return node.points.map(point => objectValue([['x', point.x], ['y', point.y]]));
    if (node.kind === 'picture' && key === 'crop' && node.crop !== null) {
        return objectValue(['x0', 'y0', 'x1', 'y1', 'circle'].map(name => [name, node.crop![name as keyof typeof node.crop]]));
    }
    if (node.kind === 'linkcard' && key === 'preview' && node.preview !== null) {
        return objectValue(['title', 'description', 'image', 'favicon'].map(name => [name, node.preview![name as keyof typeof node.preview]]));
    }
    return omitted(value, NODE_DEFAULTS[node.kind], key);
}
function line(identity: RecordIdentity, value: unknown): EncodedRecord { return { identity, text: jsonText(value) }; }
function singleton(type: 'pen' | 'view' | 'paper' | 'host', fields: readonly Field[], ext?: ExtBag | null): EncodedRecord {
    return line({ category: type, type }, objectValue([['type', type], ...fields], ext));
}

export function encodePen(ui: UiBlock): WriteResult<EncodedRecord> {
    return guardWrite(() => {
        const fields: Field[] = ['fill', 'dash', 'size', 'font', 'align', 'textAlign', 'valign', 'headStart', 'headEnd', 'route', 'spline', 'highlighterColor']
            .map(key => [key, omitted(ui.next[key as keyof typeof ui.next], UI_DEFAULTS.next, key)]);
        const next = fields.some(([, value]) => value !== undefined) ? objectValue(fields) : undefined;
        return singleton('pen', [[PEN_FILE_FIELDS.tool[0], omitted(ui.tool, UI_DEFAULTS, 'tool')],
        [PEN_FILE_FIELDS.next[0], omitted(ui.next.color, UI_DEFAULTS.next, 'color')],
        [PEN_FILE_FIELDS.penWidth[0], omitted(ui.penWidth, UI_DEFAULTS, 'penWidth')], [PEN_FILE_FIELDS.next[1], next]], ui.ext);
    });
}
export function encodeView(view: ViewFlags, saved?: SavedView): WriteResult<EncodedRecord> {
    return guardWrite(() => singleton('view', [
        ['sheet', saved?.sheet], ['x', saved?.x], ['y', saved?.y], ['zoom', saved?.zoom],
        ['grid', omitted(view.grid, VIEW_DEFAULTS, 'grid')], ['focusMode', omitted(view.focusMode, VIEW_DEFAULTS, 'focusMode')],
        ['toolLock', omitted(view.toolLock, VIEW_DEFAULTS, 'toolLock')], ['transparent', omitted(view.transparent, VIEW_DEFAULTS, 'transparent')],
        ['debugMode', omitted(view.debugMode, VIEW_DEFAULTS, 'debugMode')],
    ], view.ext));
}
export function encodePaper(host: Extract<HostBlock, { kind: 'notebook'; }>): WriteResult<EncodedRecord> {
    return guardWrite(() => singleton('paper', [
        ['size', host.paper.size], ['orientation', host.paper.orientation], ['ruling', host.paper.ruling],
        ['spacing', host.paper.spacing], ['margin', host.paper.margin], [PAPER_FILE_FIELDS.pageCount[0], host.paper.pageCount],
    ], host.ext));
}
export function encodeHost(host: Extract<HostBlock, { kind: 'pdf-ink'; }>): WriteResult<EncodedRecord> {
    return guardWrite(() => {
        if (host.pages.length < 1 || host.pages.length > FORMAT_LIMITS.pdfPages) refuseWrite('limit', 'PDF host page count is outside 1…65,536');
        for (const page of host.pages) {
            if (page.length !== 2 || page.some(size => !Number.isFinite(size) || size <= 0 || size > FORMAT_LIMITS.pdfPageSize)) refuseWrite('invalid', 'PDF display size is outside 0…14,400 points');
        }
        const pdf = compactRaw(host.pdf);
        if (!pdf.startsWith('{') || !pdf.endsWith('}')) refuseWrite('invalid', 'PDF host bookkeeping must be an opaque object');
        return singleton('host', [['pdf', rawValue(host.pdf)], ['pages', host.pages]], host.ext);
    });
}
export function encodeMedia(media: MediaEntry): WriteResult<EncodedRecord> {
    return guardWrite(() => {
        const video = media.mime.startsWith('video/');
        if (video ? media.duration === null || !Number.isFinite(media.duration) || media.duration < 0 : media.duration !== null) {
            refuseWrite('invalid', 'Video duration must be finite and nonnegative; pictures use null');
        }
        return line({ category: 'media', type: 'media', id: media.id }, objectValue([
            ['type', 'media'], ['id', media.id], ['mime', media.mime], ['w', media.w], ['h', media.h], ['bytes', media.bytes],
            ['duration', video ? media.duration : undefined], ['file', omitted(media.file, MEDIA_DEFAULTS, 'file')],
            ['animated', omitted(media.animated, MEDIA_DEFAULTS, 'animated')], ['name', omitted(media.name, MEDIA_DEFAULTS, 'name')],
        ], media.ext));
    });
}
export function encodeSheet(sheet: Sheet): WriteResult<EncodedRecord> {
    return guardWrite(() => line({ category: 'sheet', type: 'sheet', id: sheet.id }, objectValue([
        ['type', 'sheet'], ['id', sheet.id], ['name', sheet.name], ['order', sheet.order],
    ], sheet.ext)));
}
export function encodeNode(node: Node, doc: Pick<BoardDoc, 'kind' | 'sheets'>, context: EncoderContext): WriteResult<EncodedRecord> {
    return guardWrite(() => {
        const identity: RecordIdentity = { category: 'node', type: 'node', id: node.id };
        if (node.kind === 'opaque') {
            const text = compactRaw(node.raw);
            if (!text.startsWith('{') || !text.endsWith('}')) refuseWrite('invalid', 'Opaque node must retain its whole record');
            return line(identity, rawValue(node.raw));
        }
        const pagedRoot = doc.kind !== 'whiteboard' && doc.sheets.has(node.parent as SheetId);
        if (pagedRoot && (!Number.isSafeInteger(node.page) || node.page < 0)) refuseWrite('invalid', 'Paged root node needs a nonnegative page');
        if (!pagedRoot && node.page !== -1) refuseWrite('invalid', 'Only a paged root node may carry a page');
        const rotation = angle(node.rotation), bounds = context.bounds(node);
        if (bounds.length !== 4 || bounds.some(value => !Number.isFinite(value) || Math.abs(value) > FORMAT_LIMITS.world)
            || bounds[2] < 0 || bounds[3] < 0) refuseWrite('invalid', 'Drawn bounds need finite, bounded x,y,w,h with nonnegative sizes');
        const fields: Field[] = [
            ['type', 'node'], ['id', node.id], ['kind', node.kind], ['parent', node.parent], ['order', node.order],
            ['page', pagedRoot ? node.page : undefined], ['x', node.x], ['y', node.y],
            [NODE_FILE_FIELDS.rotation[0], omitted(rotation, COMMON_NODE_DEFAULTS, 'rotation')],
            ['locked', omitted(node.locked, COMMON_NODE_DEFAULTS, 'locked')],
            ['opacity', omitted(node.opacity, COMMON_NODE_DEFAULTS, 'opacity')], ['b', bounds],
        ];
        for (const key of NODE_PROPERTY_ORDER[node.kind]) {
            const name = key === 'pts' ? NODE_FILE_FIELDS.samples[0] : key;
            fields.push([name, nodeProperty(node, key, context)]);
        }
        return line(identity, objectValue(fields, node.ext));
    });
}
export function encodeHeader(kind: BoardKind, preserved: PreservedBlock): WriteResult<string> {
    return guardWrite(() => {
        if (kind !== 'whiteboard' && kind !== 'notebook' && kind !== 'pdf-ink') refuseWrite('invalid', 'Unsupported board kind');
        const [major, minor] = preserved.version;
        if (major !== NATIVE_VERSION[0] || !Number.isSafeInteger(minor) || minor < 0) refuseWrite('invalid', 'Cannot write an unsupported source format version');
        const fields: Field[] = [['format', 'board'], ['version', [major, Math.max(NATIVE_VERSION[1], minor)]], ['kind', kind]];
        if (kind !== 'pdf-ink') fields.push(['fence', COMPATIBILITY_FENCE], ['document', fenceDocument()]);
        // Keep reserved header names out of the unknown-field channel, even on PDF ink.
        for (const key of ['format', 'version', 'kind', 'fence', 'document', 'records']) {
            if (preserved.fields.has(key)) refuseWrite('invalid', 'Unknown header field collides with the envelope', key);
        }
        const header = jsonText(objectValue(fields, { fields: preserved.fields, raw: new Map() }));
        return header.slice(0, -1) + ',"records":[';
    });
}
export function encodeEnd(count: number, endExt: ExtBag | null = null): WriteResult<string> {
    return guardWrite(() => {
        if (!Number.isSafeInteger(count) || count < 0 || count >= FORMAT_LIMITS.records) refuseWrite('limit', 'End count exceeds the native record limit');
        // R-W30: only unknown end fields are preserved; neither type nor count may be shadowed.
        if (endExt?.raw.size) refuseWrite('invalid', 'End count belongs to the session, not preserved data');
        return jsonText(objectValue([['type', 'end'], ['count', count]], endExt));
    });
}
export function encodeOpaque(record: PreservedBlock['records'][number]): WriteResult<EncodedRecord> {
    return guardWrite(() => {
        const text = compactRaw(record.raw);
        if (!text.startsWith('{') || !text.endsWith('}')) refuseWrite('invalid', 'Opaque record must retain its whole object');
        return line({ category: 'opaque', type: record.type, id: record.id }, rawValue(record.raw));
    });
}

export function encodeRecord(doc: BoardDoc, identity: RecordIdentity, context: EncoderContext): WriteResult<EncodedRecord | null> {
    if (doc.kind !== doc.host.kind) return { ok: false, error: { code: 'invalid', reason: 'Board and host kinds do not match' } };
    switch (identity.category) {
        case 'pen': return encodePen(doc.ui);
        case 'view': return encodeView(doc.view, context.savedView());
        case 'paper': return doc.host.kind === 'notebook' ? encodePaper(doc.host) : { ok: true, value: null };
        case 'host': return doc.host.kind === 'pdf-ink' ? encodeHost(doc.host) : { ok: true, value: null };
        case 'media': {
            const entry = doc.media.get(identity.id as MediaId);
            return entry && mediaReferenced(entry.id, context) ? encodeMedia(entry) : { ok: true, value: null };
        }
        case 'sheet': {
            const sheet = doc.sheets.get(identity.id as SheetId);
            return sheet ? encodeSheet(sheet) : { ok: true, value: null };
        }
        case 'node': {
            const node = doc.nodes.get(identity.id as NodeId);
            return node ? encodeNode(node, doc, context) : { ok: true, value: null };
        }
        case 'opaque': return { ok: false, error: { code: 'invalid', reason: 'Opaque records are immutable; retain their existing lines' } };
    }
}
export function* encodeDocumentRecords(doc: BoardDoc, context: EncoderContext): Iterable<WriteResult<EncodedRecord>> {
    if (doc.kind !== doc.host.kind) {
        yield { ok: false, error: { code: 'invalid', reason: 'Board and host kinds do not match' } };
        return;
    }
    if (doc.sheets.size < 1 || doc.sheets.size > FORMAT_LIMITS.sheets) {
        yield { ok: false, error: { code: 'limit', reason: 'Board needs 1…1,000 sheets' } };
        return;
    }
    yield encodePen(doc.ui);
    yield encodeView(doc.view, context.savedView());
    if (doc.host.kind === 'notebook') yield encodePaper(doc.host);
    if (doc.host.kind === 'pdf-ink') yield encodeHost(doc.host);
    // R-W22: retained history/clipboard media is not live; the model maintains this index per transaction.
    for (const entry of doc.media.values()) if (mediaReferenced(entry.id, context)) yield encodeMedia(entry);
    for (const sheet of doc.sheets.values()) yield encodeSheet(sheet);
    for (const node of doc.nodes.values()) yield encodeNode(node, doc, context);
    for (const record of doc.preserved.records) yield encodeOpaque(record);
}
