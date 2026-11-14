import { sha256 } from '../../utils/sha256';
import { reorderBidiLine } from './bidi';
import { BoardFonts, fontCss, fontDescriptor, fontSupports, type FontKey } from './fonts';
import { itemizeBlock, type ItemizedBlock, type TextItem } from './itemize';
import { ReferenceMeasurer } from './measure';
import { CaretLineCache, makeCaretIndex } from './caretIndex';
import { wrapBlock } from './wrap';
import type { Face, FaceTable, InkRef, PaintFragment, PaintLine, PaintRect, TextLayoutEngine, TextLayoutRequest, TextMeasurement, TextPaint } from './paint';
import type { Marks } from './richText';

interface Piece { readonly from: number; readonly to: number; readonly item: TextItem; readonly face: number; readonly ink: InkRef; readonly text: string; readonly width: number; readonly fallback: boolean }
interface LineDraft { readonly block: ItemizedBlock; readonly from: number; readonly to: number; readonly height: number; readonly heading: boolean; readonly pieces: readonly Piece[]; readonly width: number; readonly marker: string; readonly markerFace: number; readonly markerWidth: number; readonly indent: number }
const headingScale: Record<string, number> = { h1: 2, h2: 1.5, h3: 1.17, h4: 1, h5: 0.83, h6: 0.67 };
const hardBreak = /[\r\n\u0085\u2028\u2029]+$/u;
function faceKey(font: FontKey['family'], marks: Marks, heading: boolean): FontKey {
    return { family: marks.code ? 'mono' : font, bold: !!marks.b || heading, italic: !!marks.i };
}
function role(ink: InkRef, marks: Marks): InkRef {
    return { swatch: ink.swatch, role: marks.link ? 'link' : marks.code ? 'code' : ink.role };
}

/** A session owns one instance and its append-only face table. */
export class BoardTextLayout implements TextLayoutEngine {
    private readonly faces: Face[] = [];
    private readonly faceIds = new Map<string, number>();
    readonly faceTable: FaceTable = { faces: this.faces };
    private readonly layouts = new Map<string, { paint: TextPaint; measurement: TextMeasurement }>();
    private readonly caretLines = new CaretLineCache();
    constructor(private readonly measurer: ReferenceMeasurer, private readonly fonts: BoardFonts) {}
    async prepare(request: TextLayoutRequest): Promise<void> {
        const keys = new Map<string, FontKey>();
        for (const block of request.text.blocks) {
            const heading = block.kind[0] === 'h';
            for (const run of block.runs) {
                const key = faceKey(request.style.font, run.marks, heading);
                keys.set(JSON.stringify(key), key);
            }
            const key = faceKey(request.style.font, {}, heading);
            keys.set(JSON.stringify(key), key);
        }
        await Promise.all([...keys.values()].map(key => this.fonts.ensure(key)));
    }
    private face(key: FontKey, size: number): number {
        const descriptor = fontDescriptor(key);
        const id = JSON.stringify([descriptor.url, size]);
        const old = this.faceIds.get(id);
        if (old !== undefined) return old;
        const m = descriptor.metrics, scale = size / m.unitsPerEm;
        const face: Face = { css: fontCss(descriptor), size, ascent: m.ascent * scale, descent: m.descent * scale, xHeight: m.xHeight * scale };
        const next = this.faces.length;
        this.faces.push(face);
        this.faceIds.set(id, next);
        return next;
    }
    private pieces(block: ItemizedBlock, from: number, to: number, request: TextLayoutRequest, size: number, heading: boolean): Piece[] {
        const end = from + block.text.slice(from, to).replace(hardBreak, '').length;
        const pieces: Piece[] = [];
        let lo = 0, hi = block.items.length;
        while (lo < hi) {
            const mid = (lo + hi) >> 1;
            if (block.items[mid].to <= from) lo = mid + 1;
            else hi = mid;
        }
        for (let i = lo; i < block.items.length && block.items[i].from < end; i++) {
            const item = block.items[i];
            const a = Math.max(from, item.from), b = Math.min(end, item.to);
            if (a >= b) continue;
            const key = faceKey(request.style.font, item.marks, heading);
            const face = this.face(key, size), text = block.text.slice(a, b);
            const width = this.measurer.measure(this.faces[face], text, !!(item.level & 1), request.fontEpoch).width * size / 64;
            // Canvas exposes no glyph IDs: cmap rules out unsupported codepoints, while
            // presentation sequences remain conservative for export's raster fallback.
            const fallback = !this.fonts.isLoaded(key) || !fontSupports(key, text);
            pieces.push({ from: a, to: b, item, face, ink: role(request.style.ink, item.marks), text, width, fallback });
        }
        return pieces;
    }
    private visual(block: ItemizedBlock, from: number, to: number, pieces: readonly Piece[]): Piece[] {
        const order = reorderBidiLine(block.bidi, from, to);
        const ranks = new Array<number>(pieces.length).fill(Infinity);
        order.forEach((index, rank) => {
            const character = block.bidi.characters[index];
            let lo = 0, hi = pieces.length;
            while (lo < hi) {
                const mid = (lo + hi) >> 1;
                if (pieces[mid].to <= character.start) lo = mid + 1;
                else hi = mid;
            }
            if (lo < pieces.length && pieces[lo].from < character.end) ranks[lo] = Math.min(ranks[lo], rank);
        });
        const indexed = pieces.map((piece, index) => ({ piece, index, rank: ranks[index] }));
        indexed.sort((a, b) => a.rank - b.rank || a.index - b.index);
        return indexed.map(x => x.piece);
    }
    private build(request: TextLayoutRequest): { paint: TextPaint; measurement: TextMeasurement } {
        const states = new Map<string, boolean>();
        for (const block of request.text.blocks) {
            const heading = block.kind[0] === 'h';
            for (const run of block.runs) {
                const font = faceKey(request.style.font, run.marks, heading);
                states.set(JSON.stringify(font), this.fonts.isLoaded(font));
            }
            const font = faceKey(request.style.font, {}, heading);
            states.set(JSON.stringify(font), this.fonts.isLoaded(font));
        }
        const key = sha256(new TextEncoder().encode(JSON.stringify([request.revision, request.text, request.style, request.width, request.fontEpoch, [...states].sort()])));
        const old = this.layouts.get(key);
        if (old) return old;
        const style = request.style, pad = style.padding;
        const outerWidth = request.width === null ? null : Math.max(16, request.width);
        const available = outerWidth === null ? null : Math.max(0, outerWidth - pad.left - pad.right);
        let drafts: LineDraft[] = [];
        let offset = 0;
        const listCounters: number[] = [];
        let appliedScale = 1;
        if (style.overflow === 'shrink' && available !== null) {
            for (const block of request.text.blocks) {
                const indexed = itemizeBlock(block, 0);
                const heading = block.kind[0] === 'h';
                const size = style.size * (headingScale[block.kind] ?? 1);
                const listInset = block.kind === 'ul' || block.kind === 'ol' ? (block.level + 2) * size * 1.25 : 0;
                const width = Math.max(0, available - listInset);
                let previous = 0;
                for (const point of indexed.breaks) {
                    const pieces = this.pieces(indexed, previous, point.offset, request, size, heading);
                    const wordWidth = pieces.reduce((sum, piece) => sum + piece.width, 0);
                    if (wordWidth > width) appliedScale = Math.min(appliedScale, Math.max(0.5, width / wordWidth));
                    previous = point.offset;
                }
            }
        }
        for (const block of request.text.blocks) {
            const indexed = itemizeBlock(block, offset);
            const heading = block.kind[0] === 'h';
            const baseSize = style.size * (headingScale[block.kind] ?? 1) * appliedScale;
            const isList = block.kind === 'ul' || block.kind === 'ol';
            let ordered = 0;
            if (isList) {
                listCounters.length = block.level + 1;
                if (block.kind === 'ol') {
                    ordered = block.start ?? ((listCounters[block.level] ?? 0) + 1);
                    listCounters[block.level] = ordered;
                } else listCounters[block.level] = 0;
            } else listCounters.length = 0;
            const marker = block.kind === 'ul' ? '•' : block.kind === 'ol' ? `${ordered}.` : '';
            const markerFace = this.face(faceKey(style.font, {}, heading), baseSize);
            const markerWidth = marker ? this.measurer.measure(this.faces[markerFace], marker, false, request.fontEpoch).width * baseSize / 64 + baseSize * 0.35 : 0;
            const indent = isList ? (block.level + 1) * baseSize * 1.25 + markerWidth : 0;
            const width = available === null ? null : Math.max(0, available - indent);
            const size = baseSize;
            const advance = (a: number, b: number) => this.pieces(indexed, a, b, request, size, heading).reduce((sum, piece) => sum + piece.width, 0);
            const lines = wrapBlock(indexed, width, style.overflow === 'grapheme', advance);
            for (let i = 0; i < lines.length; i++) {
                const { from, to } = lines[i];
                const pieces = this.visual(indexed, from, to, this.pieces(indexed, from, to, request, size, heading));
                drafts.push({ block: indexed, from, to, height: size * 1.35, heading, pieces, width: pieces.reduce((sum, p) => sum + p.width, 0), marker: i === 0 ? marker : '', markerFace, markerWidth, indent });
            }
            offset += indexed.text.length + 1;
        }
        if (style.maxLines !== undefined && Number.isFinite(style.maxLines)) {
            const limit = Math.max(1, Math.floor(style.maxLines));
            const clipped = drafts.length > limit;
            drafts = drafts.slice(0, limit);
            const last = drafts[drafts.length - 1];
            const width = available === null ? null : Math.max(0, available - (last?.indent ?? 0));
            if (last && style.ellipsis && (clipped || (width !== null && last.width > width))) {
                const size = this.faces[last.pieces[0]?.face ?? last.markerFace].size;
                const face = last.pieces[0]?.face ?? last.markerFace;
                const ellipsis = '…';
                const ellipsisWidth = this.measurer.measure(this.faces[face], ellipsis, false, request.fontEpoch).width * size / 64;
                const boundaries = last.block.graphemes.filter(n => n >= last.from && n <= last.to);
                const room = width === null ? Infinity : Math.max(0, width - ellipsisWidth);
                let lo = 0, hi = boundaries.length - 1, fit = last.from;
                while (lo <= hi) {
                    const mid = (lo + hi) >> 1;
                    const candidate = this.pieces(last.block, last.from, boundaries[mid], request, size, last.heading);
                    if (candidate.reduce((sum, piece) => sum + piece.width, 0) <= room) { fit = boundaries[mid]; lo = mid + 1; }
                    else hi = mid - 1;
                }
                const pieces = this.visual(last.block, last.from, fit, this.pieces(last.block, last.from, fit, request, size, last.heading));
                const item: TextItem = { from: fit, to: fit, level: last.block.bidi.level, marks: {} };
                const marker: Piece = { from: fit, to: fit, item, face, ink: style.ink, text: ellipsis, width: ellipsisWidth, fallback: true };
                if (last.block.bidi.level & 1) pieces.unshift(marker); else pieces.push(marker);
                drafts[drafts.length - 1] = { ...last, to: fit, pieces, width: pieces.reduce((sum, piece) => sum + piece.width, 0) };
            }
        }
        const contentWidth = drafts.reduce((maximum, line) => Math.max(maximum, line.width + line.indent), 0);
        const boxWidth = outerWidth ?? contentWidth + pad.left + pad.right;
        const naturalHeight = pad.top + pad.bottom + drafts.reduce((sum, line) => sum + line.height, 0);
        const boxHeight = Math.max(style.minHeight, naturalHeight);
        const spareY = boxHeight - naturalHeight;
        let y = pad.top + (style.verticalAlign === 'middle' ? spareY / 2 : style.verticalAlign === 'end' ? spareY : 0);
        const backgrounds: PaintRect[] = [], decorations: PaintRect[] = [], lines: PaintLine[] = [];
        let left = 0, top = 0, right = boxWidth, bottom = boxHeight;
        for (const draft of drafts) {
            const direction = draft.block.bidi.level & 1 ? 'rtl' : 'ltr';
            const inner = Math.max(0, boxWidth - pad.left - pad.right - draft.indent);
            const alignment = style.align === 'middle' ? (inner - draft.width) / 2 : (style.align === 'end') !== (direction === 'rtl') ? inner - draft.width : 0;
            let x = pad.left + (direction === 'ltr' ? draft.indent : 0) + alignment;
            const lineX = x;
            let ascent = this.faces[draft.markerFace].ascent, descent = this.faces[draft.markerFace].descent;
            for (const piece of draft.pieces) {
                ascent = Math.max(ascent, this.faces[piece.face].ascent);
                descent = Math.max(descent, this.faces[piece.face].descent);
            }
            const baseline = y + (draft.height - ascent - descent) / 2 + ascent;
            const fragments: PaintFragment[] = [];
            if (draft.marker) {
                const markerX = direction === 'ltr' ? x - draft.markerWidth : x + draft.width + draft.markerWidth * 0.35;
                const markerFace = this.faces[draft.markerFace];
                const metric = this.measurer.measure(markerFace, draft.marker, false, request.fontEpoch);
                const scale = markerFace.size / 64;
                const markerWidth = metric.width * scale;
                left = Math.min(left, markerX - metric.left * scale); right = Math.max(right, markerX + metric.right * scale);
                top = Math.min(top, baseline - metric.ascent * scale); bottom = Math.max(bottom, baseline + metric.descent * scale);
                fragments.push({ text: draft.marker, x: markerX, width: markerWidth, rtl: false, face: draft.markerFace, ink: style.ink, systemFallback: true, src: [draft.block.offset + draft.from, draft.block.offset + draft.from] });
            }
            for (const piece of draft.pieces) {
                const f = this.faces[piece.face], scale = f.size / 64;
                const metric = this.measurer.measure(f, piece.text, !!(piece.item.level & 1), request.fontEpoch);
                fragments.push({ text: piece.text, x, width: piece.width, rtl: !!(piece.item.level & 1), face: piece.face, ink: piece.ink, systemFallback: piece.fallback, src: [draft.block.offset + piece.from, draft.block.offset + piece.to] });
                left = Math.min(left, x - metric.left * scale); right = Math.max(right, x + metric.right * scale);
                top = Math.min(top, baseline - metric.ascent * scale); bottom = Math.max(bottom, baseline + metric.descent * scale);
                const marks = piece.item.marks;
                if (marks.hl || marks.code) backgrounds.push({ x, y, w: piece.width, h: draft.height, ink: piece.ink });
                const descriptor = fontDescriptor(faceKey(style.font, marks, draft.heading));
                const m = descriptor.metrics, unit = f.size / m.unitsPerEm;
                if (marks.u || marks.link) decorations.push({ x, y: baseline - m.underlinePosition * unit, w: piece.width, h: m.underlineThickness * unit, ink: piece.ink });
                if (marks.s) decorations.push({ x, y: baseline - m.strikePosition * unit, w: piece.width, h: m.strikeThickness * unit, ink: piece.ink });
                x += piece.width;
            }
            fragments.sort((a, b) => a.x - b.x);
            lines.push({ top: y, bottom: y + draft.height, baseline, x: lineX, direction, src: [draft.block.offset + draft.from, draft.block.offset + draft.to], fragments });
            y += draft.height;
        }
        const ink = { x: left, y: top, width: right - left, height: bottom - top };
        const paint: TextPaint = { key, fontEpoch: request.fontEpoch, box: { w: boxWidth, h: boxHeight }, ink, backgrounds, lines, decorations };
        const measurement: TextMeasurement = { box: paint.box, ink, requiredHeight: naturalHeight, fontScale: appliedScale };
        const result = { paint, measurement };
        this.layouts.set(key, result);
        if (this.layouts.size > 512) this.layouts.delete(this.layouts.keys().next().value!);
        return result;
    }
    measure(request: TextLayoutRequest): TextMeasurement { return this.build(request).measurement; }
    layout(request: TextLayoutRequest): TextPaint { return this.build(request).paint; }
    caretIndex(request: TextLayoutRequest, paint: TextPaint) { return makeCaretIndex(request, paint, this.faceTable, this.measurer, this.caretLines); }
}
