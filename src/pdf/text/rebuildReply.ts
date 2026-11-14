import type { PageGeometry } from '../../platform/types';
import type { PdfPageGeometry } from '../../utils/pdfPageText';
import { boolean, finite, integer, invalidPdfReply, record, text } from '../pool/validationCommon';
import type { PageSelectionModel, PageTextReply, PdfTextDetail } from '../worker/protocol';
import type { FigureTag, Schema2Interval, Schema2PageText } from './types';
import { validatePdfTextReply } from './validate';

const channel = new MessageChannel(), waiters: Array<() => void> = [];
channel.port1.onmessage = () => { waiters.shift()?.(); };
const yieldTask = () => new Promise<void>(resolve => { waiters.push(resolve); channel.port2.postMessage(0); });
function list(value: unknown, max: number): unknown[] {
    if (!Array.isArray(value) || value.length > max) invalidPdfReply();
    return value;
}
function owned<T extends Uint8Array | Uint32Array | Float32Array>(value: unknown, kind: { new(buffer: ArrayBuffer): T }): T {
    if (!(value instanceof kind) || !(value.buffer instanceof ArrayBuffer) || value.byteOffset !== 0 || value.byteLength !== value.buffer.byteLength) invalidPdfReply();
    return value;
}
function reasons(value: unknown): string[] { return list(value, 64).map(item => text(item, 1024)); }
function quality(value: unknown): PageTextReply['quality'] {
    if (value !== 'available' && value !== 'partial' && value !== 'none') invalidPdfReply();
    return value;
}
function tuple(value: unknown, length: number): number[] {
    const values = list(value, length);
    if (values.length !== length) invalidPdfReply();
    return values.map(item => finite(item, -1e8, 1e8));
}
function figure(value: unknown): FigureTag {
    const o = record(value, ['box', 'alt', 'offset']), box = record(o.box, ['x', 'y', 'width', 'height']);
    return { box: { x: finite(box.x, -1e8, 1e8), y: finite(box.y, -1e8, 1e8),
        width: finite(box.width, 0, 1e8), height: finite(box.height, 0, 1e8) }, alt: text(o.alt, 1024), offset: integer(o.offset, 0, 1_000_000) };
}

/** Rebuilds parser-controlled records after semantic validation. Typed-array storage
 * is already transferred, but a shared or oversized backing buffer is not accepted. */
export async function rebuildPdfTextReply(value: unknown, expected: {
    docKey: string; page: number; detail: PdfTextDetail; geometry?: Readonly<PageGeometry>;
}, signal?: AbortSignal): Promise<PageTextReply> {
    signal?.throwIfAborted();
    const o = record(value, ['docKey', 'page', 'schema', 'text', 'tokenBreaks', 'quality', 'reasons', 'model', 'digest', 'sel']);
    if (o.docKey !== expected.docKey || o.page !== expected.page || o.schema !== 2 ||
        !Number.isSafeInteger(expected.page) || expected.page < 0 || expected.page >= 100_000 ||
        !['text', 'model', 'select'].includes(expected.detail)) invalidPdfReply();
    const tokenBreaks = owned(o.tokenBreaks, Uint32Array);
    const reply: PageTextReply = { docKey: expected.docKey, page: expected.page, schema: 2,
        text: text(o.text, 1_000_000), tokenBreaks, quality: quality(o.quality), reasons: reasons(o.reasons) };
    if (expected.detail === 'text') {
        if (o.model !== undefined || o.digest !== undefined || o.sel !== undefined) invalidPdfReply();
    } else {
        if (!expected.geometry || o.model === undefined || o.digest === undefined || (expected.detail === 'select') !== (o.sel !== undefined)) invalidPdfReply();
        // Preliminary shape checks keep the existing semantic validator from
        // touching unbounded views or treating a clone's prototype as authority.
        const m = record(o.model, ['schema', 'physicalPageIndex', 'text', 'intervals', 'tokenBreaks', 'quality', 'reasons', 'geometry']);
        const g = record(m.geometry, ['physicalPageIndex', 'viewBox', 'rotation', 'userUnit', 'width', 'height', 'viewportTransform']);
        const intervals = list(m.intervals, 400_000), breaks = list(m.tokenBreaks, 200_000);
        const geom: PdfPageGeometry = { physicalPageIndex: integer(g.physicalPageIndex, 0, 99_999),
            viewBox: tuple(g.viewBox, 4) as unknown as PdfPageGeometry['viewBox'], rotation: integer(g.rotation, 0, 270),
            userUnit: finite(g.userUnit, 1, 1), width: finite(g.width, 1, 14_400), height: finite(g.height, 1, 14_400),
            viewportTransform: tuple(g.viewportTransform, 6) as unknown as PdfPageGeometry['viewportTransform'] };
        const model: Schema2PageText = { schema: 2, physicalPageIndex: integer(m.physicalPageIndex, 0, 99_999),
            text: text(m.text, 1_000_000), intervals: [], tokenBreaks: breaks.map(item => integer(item, 0, reply.text.length)),
            quality: quality(m.quality), reasons: reasons(m.reasons), geometry: geom };
        if (m.schema !== 2 || model.quality !== reply.quality || model.reasons.length !== reply.reasons.length ||
            model.reasons.some((reason, index) => reason !== reply.reasons[index]) || geom.viewBox[0] !== 0 || geom.viewBox[1] !== 0 ||
            geom.viewBox[2] !== geom.width || geom.viewBox[3] !== geom.height) invalidPdfReply();
        const rebuilt: Schema2Interval[] = [];
        let due = performance.now() + 4;
        for (let i = 0; i < intervals.length; i++) {
            if ((i & 1023) === 0) {
                signal?.throwIfAborted();
                if (performance.now() >= due) { await yieldTask(); signal?.throwIfAborted(); due = performance.now() + 4; }
            }
            const item = record(intervals[i], ['from', 'to', 'itemIndex', 'syntheticLF', 'syntheticSpace', 'charStart', 'transform', 'width', 'height', 'dir', 'fontName', 'markedContentIds', 'role']);
            const dir = item.dir, role = item.role;
            if (dir !== 'ltr' && dir !== 'rtl' && dir !== 'ttb' || role !== 'prose' && role !== 'code' && role !== 'formula' && role !== 'ambiguous') invalidPdfReply();
            rebuilt.push({ from: integer(item.from, 0, reply.text.length), to: integer(item.to, 0, reply.text.length),
                itemIndex: integer(item.itemIndex, 0, 400_000), syntheticLF: boolean(item.syntheticLF), syntheticSpace: boolean(item.syntheticSpace),
                ...(item.charStart === undefined ? {} : { charStart: integer(item.charStart, 0, 200_000) }),
                transform: tuple(item.transform, 6), width: finite(item.width, 0, 1e8), height: finite(item.height, 0, 1e8), dir,
                fontName: text(item.fontName, 128), markedContentIds: list(item.markedContentIds, 20_000).map(id => text(id, 128)), role });
        }
        model.intervals = rebuilt;
        reply.model = model;
        const digest = text(o.digest, 64);
        if (!/^[0-9a-f]{64}$/.test(digest)) invalidPdfReply();
        reply.digest = digest;
        if (expected.detail === 'select') {
            const s = record(o.sel, ['charU16', 'loose', 'flags', 'lines', 'lineBox', 'lineDir', 'lineBidi', 'clusters', 'headingLevels', 'figures']);
            const sel: PageSelectionModel = { charU16: owned(s.charU16, Uint32Array), loose: owned(s.loose, Float32Array),
                flags: owned(s.flags, Uint8Array), lines: owned(s.lines, Uint32Array), lineBox: owned(s.lineBox, Float32Array),
                lineDir: owned(s.lineDir, Float32Array), lineBidi: owned(s.lineBidi, Uint8Array), clusters: owned(s.clusters, Uint32Array),
                figures: list(s.figures, 20_000).map(figure) };
            if (s.headingLevels !== undefined) sel.headingLevels = list(s.headingLevels, 200_000).map(value => {
                const pair = list(value, 2); if (pair.length !== 2) invalidPdfReply();
                return [integer(pair[0], 0, 199_999), integer(pair[1], 1, 6) as 1 | 2 | 3 | 4 | 5 | 6];
            });
            reply.sel = sel;
        }
    }
    await validatePdfTextReply(reply, expected.geometry, expected.detail, signal);
    signal?.throwIfAborted();
    return reply;
}
