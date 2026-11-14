import { parseJson } from '../../format/jsonRead';
import type { Sheet } from '../../model/doc';
import type { RawJson } from '../../model/json';
import { sheetId, type NodeId, type SheetId } from '../../model/ids';
import type { MediaId } from '../../model/media';
import type { Node } from '../../model/nodes';
import type { SampleLease } from '../../model/samples';
import { SampleStore } from '../../ink/samples';
import { ReportBuilder, type ImportReport } from '../report';
import { scaleImportedNode } from '../scale';
import { readBasicShape } from './basic';
import { readBinding, resolveBinding, type LegacyBinding } from './bindings';
import { backdropRole, readShape, shapeBase, type LegacyShape } from './common';
import { readLegacyEnvelope, type LegacyEnvelope, type LegacyObject } from './envelope';
import { unknownShapeProperties } from './fields';
import { readLabelledShape, type RichTextReader } from './labelled';
import { readInlineAsset, type AdmitLegacyMedia, type ImportedMedia } from './media';
import { readPictureShape } from './pictures';
import { readLegacySheet } from './sheets';
import { readStroke } from './stroke';

export interface LegacyRecordOptions {
    readonly kind: 'whiteboard' | 'notebook' | 'pdf-ink';
    readonly samples: SampleStore;
    readonly rich: RichTextReader;
    readonly admitMedia: AdmitLegacyMedia;
    readonly signal?: AbortSignal;
    // Uses the node's world bounds, including parent transforms, and the saved legacy page layout.
    readonly preparePages: (shapes: readonly LegacyShape[]) => (shape: LegacyShape) => {
        readonly page: number; readonly x: number; readonly y: number; readonly scale: number; readonly pastEnd?: boolean;
    };
}
export interface LegacyRecordDraft {
    readonly source: string;
    readonly envelope: LegacyEnvelope;
    readonly sheets: readonly Sheet[];
    readonly nodes: readonly Node[];
    readonly media: readonly ImportedMedia[];
    readonly preservedRecords: readonly { readonly type: string; readonly id: string; readonly raw: RawJson }[];
    readonly leases: readonly SampleLease[];
    readonly report: ImportReport;
    readonly readOnly: boolean;
    readonly converted: false;
}

// IMP-1/5: produces an ordered draft; loading/repair must not first deduplicate it into a Map.
export async function readLegacyRecords(text: string, options: LegacyRecordOptions): Promise<LegacyRecordDraft | null> {
    const report = new ReportBuilder(), envelope = readLegacyEnvelope(text, report);
    if (!envelope) return null;
    const sheets: Sheet[] = [], shapes: LegacyShape[] = [], bindings: LegacyBinding[] = [];
    const media: ImportedMedia[] = [], assetIds = new Map<string, MediaId>(), leases: SampleLease[] = [];
    const bookmarks = new Map<string, LegacyObject>();
    const preservedRecords: { type: string; id: string; raw: RawJson }[] = [];
    try {
    for (const record of envelope.records) {
        options.signal?.throwIfAborted();
        const id = typeof record.id === 'string' ? record.id : null;
        try {
            switch (record.typeName) {
                case 'page': sheets.push(readLegacySheet(record)); report.count('sheet'); break;
                case 'shape': shapes.push(readShape(record, report)); break;
                case 'binding': bindings.push(readBinding(record)); break;
                case 'asset': {
                    if (typeof record.id !== 'string') throw new Error('Asset has no identifier');
                    // Generated page assets are host resources, not inline media.
                    if (record.id === 'asset:notebook-paper' || /^asset:pdf-page-\d+$/.test(record.id)) break;
                    if (record.type === 'bookmark') { bookmarks.set(record.id, record); break; }
                    const imported = await readInlineAsset(record, options.admitMedia, options.signal);
                    assetIds.set(record.id, imported.entry.id); media.push(imported); break;
                }
                case 'document': case 'user': {
                    if (!id) throw new Error('Metadata record has no identifier');
                    const type = `legacy-${String(record.typeName)}`;
                    preservedRecords.push({ type, id, raw: parseJson(JSON.stringify({ type, id, record })).raw() });
                    break;
                }
                default: report.refuse(id, `Unsupported record type ${String(record.typeName)}`);
            }
        } catch (error) {
            options.signal?.throwIfAborted();
            report.refuse(id, error instanceof Error ? error.message : 'Invalid record');
        }
    }
    if (!sheets.length) sheets.push({ id: sheetId('page:page'), name: 'Page 1', order: 'a1', ext: null });
    if (options.kind !== 'whiteboard' && sheets.length !== 1) report.refuse(null, 'Paged document has multiple sheets');
    const sheetIds = new Set<SheetId>(sheets.map(sheet => sheet.id));
    const knownShapes = new Set<NodeId>(shapes.map(shape => shape.id as NodeId));
    const bindingEnds = new Map<NodeId, Map<'start' | 'end', LegacyBinding>>();
    for (const binding of bindings) {
        let ends = bindingEnds.get(binding.connector);
        if (!ends) bindingEnds.set(binding.connector, ends = new Map());
        if (ends.has(binding.terminal)) report.refuse(binding.id, 'Multiple bindings for one endpoint');
        else ends.set(binding.terminal, binding);
    }
    const nodes: Node[] = [];
    const pageForRoot = options.kind === 'whiteboard' ? null : options.preparePages(shapes);
    const roots = new Map<NodeId, { readonly page: number; readonly x: number; readonly y: number; readonly scale: number }>();
    for (const shape of shapes) {
        options.signal?.throwIfAborted();
        try {
            const role = backdropRole(shape, options.kind);
            if (role === 'backdrop') continue;
            if (role === 'ambiguous') report.repair(shape.id, 'Possible page backdrop retained as a picture');
            const extras = unknownShapeProperties(shape);
            if (extras.length) report.refuse(shape.id, `Unsupported properties: ${extras.join(', ')}`);
            const root = sheetIds.has(shape.parentId as SheetId);
            const position = pageForRoot && root ? pageForRoot(shape) : null;
            if (position?.pastEnd) report.repair(shape.id, 'Content past the last page retained on the last page');
            let base = shapeBase(shape, position?.page ?? -1);
            if (shape.type === 'note' && shape.props.textLastEditedBy != null) {
                const fields = new Map(base.ext?.fields ?? []);
                fields.set('legacyTextLastEditedBy', parseJson(JSON.stringify(shape.props.textLastEditedBy)).raw());
                base = { ...base, ext: { fields, raw: base.ext?.raw ?? new Map() } };
            }
            if ((shape.type === 'image' || shape.type === 'video') && typeof shape.props.assetId === 'string'
                && !assetIds.has(shape.props.assetId)) {
                report.refuse(shape.id, `Missing or unsupported asset ${shape.props.assetId}`);
                const fields = new Map(base.ext?.fields ?? []);
                fields.set('legacyMissingAsset', parseJson(JSON.stringify(shape.props.assetId)).raw());
                base = { ...base, ext: { fields, raw: base.ext?.raw ?? new Map() } };
            }
            if (position) roots.set(base.id, position);
            let node: Node | null = null;
            if (shape.type === 'draw' || shape.type === 'highlight') {
                const stroke = readStroke(shape, base, options.samples);
                leases.push(stroke.lease); node = stroke.node;
            } else {
                const ends = bindingEnds.get(base.id);
                const start = shape.props.start, end = shape.props.end;
                let endpoints: Parameters<typeof readLabelledShape>[3];
                if (shape.type === 'arrow' && start && end && typeof start === 'object' && typeof end === 'object') {
                    const a = start as { x: number; y: number }, b = end as { x: number; y: number };
                    const resolvedStart = resolveBinding(ends?.get('start'), knownShapes, a);
                    const resolvedEnd = resolveBinding(ends?.get('end'), knownShapes, b);
                    if (resolvedStart.repair) report.repair(resolvedStart.repair.id, resolvedStart.repair.reason);
                    if (resolvedEnd.repair) report.repair(resolvedEnd.repair.id, resolvedEnd.repair.reason);
                    endpoints = { start: resolvedStart.end, end: resolvedEnd.end };
                }
                node = readBasicShape(shape, base) ?? readPictureShape(shape, base, assetIds, bookmarks)
                    ?? readLabelledShape(shape, base, options.rich, endpoints);
            }
            if (!node) report.refuse(shape.id, `Unsupported shape ${shape.type}`);
            else { nodes.push(node); report.count(node.kind); }
        } catch (error) { report.refuse(shape.id, error instanceof Error ? error.message : 'Invalid shape'); }
    }
    const byId = new Map<NodeId, Node>();
    for (const node of nodes) if (!byId.has(node.id)) byId.set(node.id, node);
    const mappedNodes = nodes.map(node => {
        let ancestor = node;
        for (let depth = 0; depth <= 64; depth++) {
            const mapped = roots.get(ancestor.id);
            if (mapped) {
                try {
                    const scaled = scaleImportedNode(node, mapped.scale);
                    return node.id === ancestor.id ? { ...scaled, x: mapped.x, y: mapped.y, page: mapped.page } : scaled;
                } catch (error) { report.refuse(node.id, error instanceof Error ? error.message : 'Invalid page scale'); return node; }
            }
            const parent = byId.get(ancestor.parent as NodeId);
            if (!parent) break;
            ancestor = parent;
        }
        return node;
    });
    const result = report.finish();
    return { source: text, envelope, sheets, nodes: mappedNodes, media, preservedRecords, leases, report: result,
        readOnly: result.unrepresentable.length > 0, converted: false };
    } catch (error) {
        for (const lease of leases) lease.release();
        throw error;
    }
}
