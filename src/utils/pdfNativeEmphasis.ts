import { OPS, version } from 'pdfjs-dist';
import type { PDFPageProxy } from 'pdfjs-dist';
import type { EmphasisAvailability } from '../types/reading';
import { EMPHASIS_ALGORITHM, emphasisRanges } from './readingEmphasis';

/** This adapter is deliberately pinned: the public operator filter is stable,
 * but glyph payloads and the two canvas painting routes are pdf.js internals.
 * Audited against pdfjs-dist 6.1.200 (Apache-2.0), display/canvas.js showText /
 * paintChar and core/fonts.js Glyph. No prototype or PDF operator is changed.
 * Re-audit on upgrade; unsupported pages keep the original paint calls. */
export const PDF_EMPHASIS_RENDERER_VERSION = '6.1.200';
export interface PdfNativeEmphasisResult {
    glyphs: number;
    candidates: number;
    painted: number;
    eligible: number;
    skipped: number;
    supported: boolean;
    reason?: 'renderer-version' | 'glyph-data' | 'page-budget';
}
export function pdfNativeEmphasisAvailability(result?: PdfNativeEmphasisResult): EmphasisAvailability {
    if (!result) return { kind: 'inactive', reason: 'Checking original PDF text for Word emphasis' };
    if (result.supported && result.eligible > 0) return { kind: 'toggle' };
    return { kind: 'inactive', reason: pdfNativeEmphasisNotice(result) || 'No supported original glyphs on this page' };
}
export function pdfNativeEmphasisNotice(result?: PdfNativeEmphasisResult): string {
    if (!result) return '';
    if (!result.supported) return result.reason === 'renderer-version'
        ? 'Word emphasis is unavailable with this PDF renderer version.'
        : 'Word emphasis is unavailable for this page’s text encoding or size.';
    if (result.glyphs === 0) return 'This page has no text glyphs to emphasize.';
    if (result.eligible === 0) return 'No supported visible word prefixes on this page.';
    return result.painted < result.candidates ? 'Word emphasis applied to supported text on this page.' : '';
}

interface Glyph {
    unicode: string; fontChar: string; isSpace: boolean; isInFont: boolean;
    accent?: { fontChar: string } | null;
}
interface Paint { readonly char: string; readonly selected: boolean; readonly inFont: boolean }
interface RunGlyph { glyph: Glyph; op: number; from: number; to: number }
export interface PdfEmphasisPlan {
    readonly result: Readonly<PdfNativeEmphasisResult>;
    readonly paints: ReadonlyMap<number, readonly Paint[]>;
    readonly fontIds: ReadonlyMap<number, string>;
}

/** The operator stream carries the embedded font's own Unicode↔glyph mapping,
 * so TextItem merging/splitting and visual column order cannot move a prefix.
 * Ligatures are indivisible: a prefix ending INSIDE one leaves that glyph alone.
 * The shared Unicode policy currently selects Latin words only. */
export function makePdfEmphasisPlan(list: Awaited<ReturnType<PDFPageProxy['getOperatorList']>>,
    algorithm: typeof EMPHASIS_ALGORITHM = EMPHASIS_ALGORITHM, locale?: string): PdfEmphasisPlan {
    const result: PdfNativeEmphasisResult = { glyphs: 0, candidates: 0, painted: 0, eligible: 0, skipped: 0,
        supported: version === PDF_EMPHASIS_RENDERER_VERSION && algorithm === EMPHASIS_ALGORITHM,
        reason: version === PDF_EMPHASIS_RENDERER_VERSION ? undefined : 'renderer-version' };
    const paints = new Map<number, Paint[]>();
    const fontIds = new Map<number, string>();
    try {
        if (result.supported) {
            let text = '', glyphs: RunGlyph[] = [], fontId = '', codeUnits = 0;
            let annotation = false;
            const fonts: string[] = [];
            const flush = () => {
                const ranges = emphasisRanges({ text, locale, exclusions: [...text.matchAll(/\S+/gu)].filter(m => m[0].includes('\uFFFD')).map(m => ({ from: m.index, to: m.index + m[0].length })) });
                let r = 0;
                for (const g of glyphs) {
                    while (r < ranges.length && ranges[r].to <= g.from) r++;
                    const selected = !!ranges[r] && ranges[r].from <= g.from && ranges[r].to >= g.to && g.to > g.from;
                    const q = paints.get(g.op) ?? [];
                    q.push({ char: g.glyph.fontChar, selected, inFont: g.glyph.isInFont });
                    if (g.glyph.accent) q.push({ char: g.glyph.accent.fontChar, selected, inFont: g.glyph.isInFont });
                    paints.set(g.op, q);
                    if (selected) result.candidates++;
                }
                text = ''; glyphs = [];
            };
            for (let op = 0; op < list.fnArray.length; op++) {
                const fn = list.fnArray[op], args = list.argsArray[op];
                if ([OPS.save, OPS.paintFormXObjectBegin, OPS.beginAnnotation].includes(fn)) fonts.push(fontId);
                if ([OPS.restore, OPS.paintFormXObjectEnd, OPS.endAnnotation].includes(fn)) fontId = fonts.pop() ?? '';
                if (fn === OPS.setFont) fontId = args[0];
                if (fn === OPS.beginAnnotation) annotation = true;
                if (fn === OPS.endAnnotation) annotation = false;
                if (fn === OPS.showText && !annotation) {
                    fontIds.set(op, fontId);
                    const values: unknown = args?.[0];
                    if (!Array.isArray(values)) { result.supported = false; result.reason = 'glyph-data'; break; }
                    for (const value of values) {
                        // TJ kerning stays in a word; a sizeable forward advance is
                        // a boundary, never an invented literal space in selection.
                        if (typeof value === 'number') { if (value < -200) flush(); continue; }
                        const g = value as Glyph;
                        if (typeof g?.unicode !== 'string' || typeof g.fontChar !== 'string') {
                            result.supported = false; result.reason = 'glyph-data'; break;
                        }
                        result.glyphs++;
                        codeUnits += g.unicode.length;
                        if (result.glyphs > 200_000 || codeUnits > 2_000_000) { result.supported = false; result.reason = 'page-budget'; break; }
                        // Unmapped/private encodings cannot supply a trustworthy word.
                        const unicode = /[\p{Co}\p{Cc}\uFFFD]/u.test(g.unicode) ? '\uFFFD' : g.unicode;
                        glyphs.push({ glyph: g, op, from: text.length, to: text.length + unicode.length });
                        text += unicode;
                    }
                    if (!result.supported) break;
                } else if (![OPS.setFont, OPS.setCharSpacing, OPS.setWordSpacing, OPS.setHScale,
                    OPS.setTextRenderingMode, OPS.setTextRise, OPS.setFillRGBColor, OPS.setFillGray,
                    OPS.setFillCMYKColor, OPS.dependency].includes(fn)) flush();
            }
            flush();
        }
    } catch {
        result.supported = false;
        result.reason = 'glyph-data';
        paints.clear(); fontIds.clear();
    }

    return { result, paints, fontIds };
}

export function bindPdfNativeEmphasis(page: PDFPageProxy, ctx: CanvasRenderingContext2D, plan: PdfEmphasisPlan) {
    const { paints, fontIds } = plan;
    const result = { ...plan.result };
    const originalFillText = ctx.fillText;
    const originalFill = ctx.fill;
    let queue: readonly Paint[] | undefined, cursor = 0;
    let font: { isType3Font?: boolean; missingFile?: boolean } | undefined;
    const eligible = () => result.supported && queue && !font?.isType3Font;
    const take = (char?: string) => {
        if (!eligible()) return false;
        const p = queue![cursor++];
        // A renderer route we didn't audit must not shift the remaining glyphs.
        if (!p || (char !== undefined && p.char !== char)) { queue = undefined; result.skipped++; return false; }
        return p.selected;
    };
    const stroke = (paint: () => void, width: number) => {
        // Pattern/soft-mask/group painting can switch to an internal context.
        // Leave these alone rather than approximate their colour/compositing.
        if (typeof ctx.fillStyle !== 'string' || ctx.globalAlpha !== 1 || ctx.globalCompositeOperation !== 'source-over') {
            result.skipped++; return;
        }
        // Candidates alone include invisible OCR/Type3; only the separate
        // final-composition proof can publish this counter as capability.
        result.eligible++;
        ctx.save();
        try {
            ctx.strokeStyle = ctx.fillStyle;
            ctx.lineWidth = width;
            ctx.lineJoin = 'round';
            ctx.setLineDash([]);
            paint();
            result.painted++;
        } catch { result.skipped++; } finally { ctx.restore(); }
    };
    ctx.fillText = function (char, x, y, maxWidth) {
        if (take(char)) {
            const size = Number.parseFloat(/([\d.]+)px/.exec(ctx.font)?.[1] ?? '0');
            if (size > 0) stroke(() => ctx.strokeText(char, x, y, maxWidth), size * .035);
        }
        originalFillText.call(ctx, char, x, y, maxWidth);
    };
    ctx.fill = function (...args: Parameters<CanvasRenderingContext2D['fill']>) {
        if (args[0] instanceof Path2D && take()) stroke(() => ctx.stroke(args[0] as Path2D), .035);
        originalFill.apply(ctx, args);
    } as CanvasRenderingContext2D['fill'];
    return {
        result,
        operationsFilter(index: number) {
            queue = undefined; cursor = 0;
            if (!result.supported) return true;
            const q = paints.get(index);
            if (q) {
                // All glyph paints of the active font must be represented in
                // this queue. isInFont=false glyphs are suppressed by pdf.js;
                // remove those from the queue unless missingFile permits paint.
                try {
                    font = page.commonObjs.get(fontIds.get(index) ?? '');
                    if (font && !font.isType3Font) queue = q.filter(p => p.inFont || font?.missingFile);
                } catch { result.skipped += q.length; }
            }
            return true; // Every original operation ALWAYS executes.
        },
        dispose() {
            ctx.fillText = originalFillText;
            ctx.fill = originalFill;
            queue = undefined; font = undefined;
        },
    };
}
