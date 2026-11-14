import { buildPdfiumPageText } from '../text/schema2';
import { buildLines } from '../text/lines';
import type { RawPageText } from '../engine/types';
import type { LineTable, Schema2Projection } from '../text/types';
import type { PageGeometry } from '../../platform/types';
import type { WorkerContext } from '../../platform/workers/serve';
import { sha256 } from '../../utils/sha256';
import type { PageTextReply, PdfDocKey, PdfTextDetail } from './protocol';

const MAX_CHARS = 200_000, MAX_OBJECTS = 20_000, MAX_FONTS = 512, MAX_STRUCT = 20_000;
interface PreparedText { geometry: string; projection: Schema2Projection; digest?: string; lines?: LineTable }
// The runtime retains at most four raw pages per worker. Weak keys make the
// canonical projection follow precisely that raw-page lifetime.
const prepared = new WeakMap<RawPageText, PreparedText>();
function invalid(): never { throw new RangeError('Invalid or oversized PDF text response'); }
function validBox(values: Float32Array, i: number, width: number, height: number): boolean {
    const x0 = values[i], y0 = values[i + 1], x1 = values[i + 2], y1 = values[i + 3];
    return [x0, y0, x1, y1].every(Number.isFinite) && x0 <= x1 && y0 <= y1 &&
        x0 >= -width / 2 && x1 <= width * 1.5 && y0 >= -height / 2 && y1 <= height * 1.5;
}

/** Validate the engine-owned arrays before any builder can allocate from them. */
export function validateRawPdfText(raw: RawPageText, geometry: PageGeometry): void {
    const n = raw.n, objects = raw.objects.renderMode.length;
    if (!Number.isSafeInteger(n) || n < 0 || n > MAX_CHARS || !Number.isFinite(geometry.width) ||
        !Number.isFinite(geometry.height) || geometry.width <= 0 || geometry.height <= 0 ||
        !Number.isSafeInteger(geometry.index) || geometry.index < 0 || !Number.isFinite(geometry.rotate) ||
        raw.codepoints.length !== n || raw.flags.length !== n || raw.loose.length !== 4 * n || raw.tight.length !== 4 * n ||
        raw.origin.length !== 2 * n || raw.matrix.length !== 4 * n || raw.textMatrix.length !== 6 * n || raw.fontSize.length !== n || raw.object.length !== n ||
        objects > MAX_OBJECTS || raw.objects.fill.length !== objects || raw.objects.mcid.length !== objects || raw.objects.font.length !== objects ||
        raw.objects.sourceFontSize.length !== objects || raw.objects.opacity.length !== objects || raw.objects.hasTransparency.length !== objects ||
        raw.fontNames.length > MAX_FONTS || raw.fontAscent.length !== raw.fontNames.length || raw.fontDescent.length !== raw.fontNames.length ||
        raw.fontNames.some(name => typeof name !== 'string' || name.length > 128)) invalid();
    for (let i = 0; i < n; i++) {
        if (!validBox(raw.loose, i * 4, geometry.width, geometry.height) || !validBox(raw.tight, i * 4, geometry.width, geometry.height) ||
            !Number.isFinite(raw.origin[i * 2]) || !Number.isFinite(raw.origin[i * 2 + 1]) ||
            !Number.isFinite(raw.fontSize[i]) || raw.fontSize[i] < 0 || raw.object[i] < -1 || raw.object[i] >= objects) invalid();
        for (let j = 0; j < 4; j++) if (!Number.isFinite(raw.matrix[i * 4 + j])) invalid();
        for (let j = 0; j < 6; j++) if (!Number.isFinite(raw.textMatrix[i * 6 + j])) invalid();
    }
    for (let i = 0; i < objects; i++) if (!Number.isFinite(raw.objects.sourceFontSize[i]) || !Number.isFinite(raw.objects.opacity[i]) ||
        raw.objects.opacity[i] < 0 || raw.objects.opacity[i] > 1 || raw.objects.hasTransparency[i] > 2) invalid();
    for (let i = 0; i < raw.fontNames.length; i++) if (!Number.isFinite(raw.fontAscent[i]) || !Number.isFinite(raw.fontDescent[i])) invalid();
    if (raw.struct) {
        const structure = raw.struct;
        if (structure.mcids.length > MAX_STRUCT || structure.roles.length !== structure.mcids.length ||
            structure.lang.length > MAX_STRUCT || structure.alt.length > MAX_STRUCT || (structure.figures?.length ?? 0) > MAX_STRUCT ||
            structure.lang.some(([id, lang]) => !Number.isInteger(id) || typeof lang !== 'string' || lang.length > 35) ||
            structure.alt.some(([id, text]) => !Number.isInteger(id) || typeof text !== 'string' || text.length > 1024) ||
            (structure.actualText?.length ?? 0) > MAX_STRUCT || structure.actualText?.some(([id, text]) => !Number.isInteger(id) || typeof text !== 'string' || text.length > 1024) ||
            structure.figures?.some(figure => !Number.isInteger(figure.mcid) || figure.box.length !== 4 ||
                !figure.box.every(Number.isFinite) || figure.charIndex !== undefined && (!Number.isInteger(figure.charIndex) || figure.charIndex < 0 || figure.charIndex >= n))) invalid();
    }
}

/** Runtime projection runs once per page. Select-detail arrays are copied so
 * transfer cannot detach a backend page retained for another caller. */
export async function buildWorkerPageText(raw: RawPageText, geometry: PageGeometry,
    args: { docKey: PdfDocKey; page: number; detail: PdfTextDetail }, context: WorkerContext): Promise<PageTextReply> {
    if (context.cancelled) throw new DOMException('PDF text operation cancelled', 'AbortError');
    if (args.page !== geometry.index) invalid();
    const geometryKey = `${geometry.index}:${geometry.width}:${geometry.height}:${geometry.rotate}`;
    let entry = prepared.get(raw);
    if (!entry || entry.geometry !== geometryKey) {
        validateRawPdfText(raw, geometry);
        context.heartbeat();
        const projection = buildPdfiumPageText(raw, { physicalPageIndex: geometry.index,
            width: geometry.width, height: geometry.height, rotation: geometry.rotate });
        const model = projection.model;
        const modelBytes = model.text.length * 2 + model.tokenBreaks.length * 8 + model.intervals.reduce((total, interval) =>
            total + 192 + interval.fontName.length * 2 + interval.markedContentIds.join('').length * 2, 0);
        if (model.text.length * 2 > 1024 * 1024 || model.intervals.length > 50_000 || modelBytes > 4 * 1024 * 1024)
            throw new RangeError('PDF text page exceeds the text model safety limit');
        entry = { geometry: geometryKey, projection }; prepared.set(raw, entry);
    }
    const { model, charU16 } = entry.projection;
    if (context.cancelled) throw new DOMException('PDF text operation cancelled', 'AbortError');
    const reply: PageTextReply = { docKey: args.docKey, page: args.page, schema: 2, text: model.text,
        tokenBreaks: Uint32Array.from(model.tokenBreaks), quality: model.quality, reasons: [...model.reasons] };
    if (args.detail !== 'text') {
        entry.digest ??= sha256(new TextEncoder().encode(JSON.stringify([2, model.text, model.geometry])));
        reply.model = model;
        reply.digest = entry.digest;
    }
    if (args.detail === 'select') {
        const lines = entry.lines ??= buildLines(raw, charU16);
        reply.sel = { charU16: charU16.slice(), loose: raw.loose.slice(), flags: raw.flags.slice(),
            lines: lines.lines.slice(), lineBox: lines.lineBox.slice(), lineDir: lines.lineDir.slice(), lineBidi: lines.lineBidi.slice(),
            clusters: lines.clusters.slice(), headingLevels: [...lines.headingLevels], figures: lines.figures };
        context.transfer(...[reply.sel.charU16, reply.sel.loose, reply.sel.flags, reply.sel.lines, reply.sel.lineBox,
            reply.sel.lineDir, reply.sel.lineBidi, reply.sel.clusters].map(array => array.buffer as ArrayBuffer));
    }
    if (context.cancelled) throw new DOMException('PDF text operation cancelled', 'AbortError');
    context.transfer(reply.tokenBreaks.buffer as ArrayBuffer);
    return reply;
}
