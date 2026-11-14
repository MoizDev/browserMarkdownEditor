import type { PageGeometry } from '../../platform/types';
import type { PageTextReply, PdfTextDetail } from '../worker/protocol';

const fail = (): never => { throw new Error('The PDF text worker returned invalid page data.'); };
const channel = new MessageChannel(), waiters: Array<() => void> = [];
channel.port1.onmessage = () => { waiters.shift()?.(); };
const yieldTask = () => new Promise<void>(resolve => { waiters.push(resolve); channel.port2.postMessage(0); });
const isInt = (value: number, max: number) => Number.isSafeInteger(value) && value >= 0 && value <= max;
function box(values: ArrayLike<number>, at: number, width: number, height: number): boolean {
    const x0 = values[at], y0 = values[at + 1], x1 = values[at + 2], y1 = values[at + 3];
    return [x0, y0, x1, y1].every(Number.isFinite) && x0 <= x1 && y0 <= y1 &&
        x0 >= -width / 2 && x1 <= width * 1.5 && y0 >= -height / 2 && y1 <= height * 1.5;
}
/** Worker replies are untrusted even after worker-side validation. Validate
 * before caching, drawing, copying, or letting offsets enter the app. */
export async function validatePdfTextReply(reply: PageTextReply, geometry: PageGeometry, detail: PdfTextDetail, signal?: AbortSignal): Promise<void> {
    let deadline = performance.now() + 4;
    const checkpoint = async () => {
        signal?.throwIfAborted();
        if (performance.now() >= deadline) { await yieldTask(); deadline = performance.now() + 4; signal?.throwIfAborted(); }
    };
    if (typeof reply.text !== 'string' || reply.text.length > 1_000_000 || !Array.isArray(reply.reasons) || reply.reasons.length > 64 ||
        reply.reasons.some(reason => typeof reason !== 'string' || reason.length > 1024) ||
        !['available', 'partial', 'none'].includes(reply.quality) || !(reply.tokenBreaks instanceof Uint32Array) ||
        reply.tokenBreaks.length > 200_000) fail();
    let previous = 0;
    for (let i = 0; i < reply.tokenBreaks.length; i++) {
        if ((i & 1023) === 0) await checkpoint();
        const offset = reply.tokenBreaks[i];
        if (offset <= previous || offset >= reply.text.length) fail();
        previous = offset;
    }
    if (detail !== 'text') {
        const model = reply.model;
        if (!model || model.schema !== 2 || model.physicalPageIndex !== reply.page || model.text !== reply.text ||
            !Array.isArray(model.intervals) || model.intervals.length > 400_000 || !Array.isArray(model.tokenBreaks) ||
            model.tokenBreaks.length !== reply.tokenBreaks.length || typeof reply.digest !== 'string' || !/^[0-9a-f]{64}$/u.test(reply.digest)) fail();
        let end = 0;
        for (let i = 0; i < model.intervals.length; i++) {
            if ((i & 1023) === 0) await checkpoint();
            const interval = model.intervals[i];
            if (!isInt(interval.from, reply.text.length) || !isInt(interval.to, reply.text.length) || interval.from !== end || interval.to < interval.from ||
                !Array.isArray(interval.transform) || interval.transform.length !== 6 || !interval.transform.every(Number.isFinite) ||
                !Number.isFinite(interval.width) || interval.width < 0 || !Number.isFinite(interval.height) || interval.height < 0 ||
                typeof interval.fontName !== 'string' || interval.fontName.length > 128 || !Array.isArray(interval.markedContentIds) ||
                interval.markedContentIds.some(id => typeof id !== 'string' || id.length > 128)) fail();
            end = interval.to;
        }
        if (end !== reply.text.length || model.tokenBreaks.some((offset, index) => offset !== reply.tokenBreaks[index])) fail();
        const page = model.geometry;
        if (!page || page.physicalPageIndex !== reply.page || page.width !== geometry.width || page.height !== geometry.height ||
            page.rotation !== geometry.rotate || page.userUnit !== 1 || page.viewportTransform.length !== 6 ||
            !page.viewportTransform.every((value, index) => value === [1, 0, 0, 1, 0, 0][index])) fail();
    }
    if (detail !== 'select') return;
    const s = reply.sel;
    if (!s || !(s.flags instanceof Uint8Array) || s.flags.length > 200_000 || !(s.charU16 instanceof Uint32Array) ||
        s.charU16.length !== s.flags.length + 1 || !(s.loose instanceof Float32Array) || s.loose.length !== s.flags.length * 4 ||
        !(s.lines instanceof Uint32Array) || s.lines.length % 2 || !(s.lineBox instanceof Float32Array) || s.lineBox.length !== s.lines.length * 2 ||
        !(s.lineDir instanceof Float32Array) || s.lineDir.length !== s.lines.length || !(s.lineBidi instanceof Uint8Array) ||
        s.lineBidi.length * 2 !== s.lines.length || !(s.clusters instanceof Uint32Array) || !Array.isArray(s.figures)) fail();
    previous = 0;
    for (let i = 0; i < s.charU16.length; i++) {
        if ((i & 1023) === 0) await checkpoint();
        const offset = s.charU16[i];
        if (offset < previous || offset > reply.text.length || i === 0 && offset !== 0) fail();
        previous = offset;
    }
    if (previous !== reply.text.length) fail();
    for (let i = 0; i < s.flags.length; i++) {
        if ((i & 1023) === 0) await checkpoint();
        if (!box(s.loose, i * 4, geometry.width, geometry.height)) fail();
    }
    previous = 0;
    for (let line = 0; line < s.lineBidi.length; line++) {
        if ((line & 1023) === 0) await checkpoint();
        const start = s.lines[line * 2], end = s.lines[line * 2 + 1], dx = s.lineDir[line * 2], dy = s.lineDir[line * 2 + 1];
        if (start < previous || end <= start || end > s.flags.length || s.lineBidi[line] > 1 || !Number.isFinite(dx) || !Number.isFinite(dy) ||
            Math.abs(Math.hypot(dx, dy) - 1) > 1e-3 || !box(s.lineBox, line * 4, geometry.width, geometry.height)) fail();
        previous = end;
    }
    previous = -1;
    for (let i = 0; i < s.clusters.length; i++) {
        if ((i & 1023) === 0) await checkpoint();
        const cluster = s.clusters[i];
        if (cluster <= previous || cluster >= s.flags.length) fail();
        previous = cluster;
    }
    if (s.headingLevels && (!Array.isArray(s.headingLevels) || s.headingLevels.length > s.lineBidi.length ||
        s.headingLevels.some(([line, level]) => !isInt(line, s.lineBidi.length - 1) || !isInt(level, 6) || level < 1))) fail();
    if (s.figures.length > 20_000 || s.figures.some(figure => {
        const r = figure.box;
        return typeof figure.alt !== 'string' || figure.alt.length > 1024 || !isInt(figure.offset, reply.text.length) ||
            !r || !box([r.x, r.y, r.x + r.width, r.y + r.height], 0, geometry.width, geometry.height);
    })) fail();
}
