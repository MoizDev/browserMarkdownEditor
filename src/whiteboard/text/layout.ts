import { reorderBidiLine } from './bidi';
import { BoardFonts, fontCss, fontDescriptor, type FontKey } from './fonts';
import { itemizeBlock, type ItemizedBlock, type TextItem } from './itemize';
import { ReferenceMeasurer } from './measure';
import { makeCaretIndex } from './caretIndex';
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
        for (const item of block.items) {
            const a = Math.max(from, item.from), b = Math.min(end, item.to);
            if (a >= b) continue;
            const key = faceKey(request.style.font, item.marks, heading);
            const face = this.face(key, size), text = block.text.slice(a, b);
            const width = this.measurer.measure(this.faces[face], text, !!(item.level & 1), request.fontEpoch).width * size / 64;
            // Canvas exposes no glyph fallback information. Rasterising uncertain non-ASCII
            // fragments on export preserves their appearance rather than claiming outlines.
            const fallback = !this.fonts.isLoaded(key) || /[^\u0020-\u007e]/u.test(text);
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
        const key = JSON.stringify([request.revision, request.text, request.style, request.width, request.fontEpoch]);
        const old = this.layouts.get(key);
        if (old) return old;
        const style = request.style, pad = style.padding;
        const outerWidth = request.width === null ? null : Math.max(16, request.width);
        const available = outerWidth === null ? null : Math.max(0, outerWidth - pad.left - pad.right);
        const drafts: LineDraft[] = [];
        let offset = 0, ordered = 0, previousList = false;
        let appliedScale = 1;
        for (const block of request.text.blocks) {
            const indexed = itemizeBlock(block, offset);
            const heading = block.kind[0] === 'h';
            const baseSize = style.size * (headingScale[block.kind] ?? 1);
            const isList = block.kind === 'ul' || block.kind === 'ol';
            ordered = block.kind === 'ol' ? block.start ?? (previousList ? ordered + 1 : 1) : 0;
            previousList = block.kind === 'ol';
            const marker = block.kind === 'ul' ? '•' : block.kind === 'ol' ? `${ordered}.` : '';
            const markerFace = this.face(faceKey(style.font, {}, heading), baseSize);
            const markerWidth = marker ? this.measurer.measure(this.faces[markerFace], marker, false, request.fontEpoch).width * baseSize / 64 + baseSize * 0.35 : 0;
            const indent = isList ? (block.level + 1) * baseSize * 1.25 + markerWidth : 0;
            const width = available === null ? null : Math.max(0, available - indent);
            let size = baseSize;
            if (style.overflow === 'shrink' && width !== null) {
                let previous = 0, widest = 0;
                for (const point of indexed.breaks) {
                    const pieces = this.pieces(indexed, previous, point.offset, request, baseSize, heading);
                    widest = Math.max(widest, pieces.reduce((sum, piece) => sum + piece.width, 0));
                    previous = point.offset;
                }
                const factor = widest > width && widest > 0 ? Math.max(0.5, width / widest) : 1;
                appliedScale = Math.min(appliedScale, factor);
                size *= factor;
            }
            const advance = (a: number, b: number) => this.pieces(indexed, a, b, request, size, heading).reduce((sum, piece) => sum + piece.width, 0);
            const lines = wrapBlock(indexed, width, style.overflow === 'grapheme', advance);
            for (let i = 0; i < lines.length; i++) {
                const { from, to } = lines[i];
                const pieces = this.visual(indexed, from, to, this.pieces(indexed, from, to, request, size, heading));
                drafts.push({ block: indexed, from, to, height: size * 1.35, heading, pieces, width: pieces.reduce((sum, p) => sum + p.width, 0), marker: i === 0 ? marker : '', markerFace, markerWidth, indent });
            }
            offset += indexed.text.length + 1;
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
            const face = this.faces[draft.pieces[0]?.face ?? draft.markerFace];
            const baseline = y + (draft.height - face.ascent - face.descent) / 2 + face.ascent;
            const fragments: PaintFragment[] = [];
            if (draft.marker) {
                const markerX = direction === 'ltr' ? x - draft.markerWidth : x + draft.width + draft.markerWidth * 0.35;
                fragments.push({ text: draft.marker, x: markerX, width: draft.markerWidth * 0.65, rtl: false, face: draft.markerFace, ink: style.ink, systemFallback: true, src: [draft.block.offset + draft.from, draft.block.offset + draft.from] });
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
            lines.push({ top: y, bottom: y + draft.height, baseline, direction, src: [draft.block.offset + draft.from, draft.block.offset + draft.to], fragments });
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
    caretIndex(request: TextLayoutRequest, paint: TextPaint) { return makeCaretIndex(request, paint, this.faceTable, this.measurer); }
}
