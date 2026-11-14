import type { Rect } from '../../platform/types';
import type { FigureNode } from '../model/nodes';
import type { Fill } from '../model/styles';
import type { TextPaint } from '../text/paint';
import { cubicBounds } from './bounds';
import type { Box } from './bounds';
import { ContourClipper, hatchLines, reflectHatch } from './clip';
import type { HatchLine } from './clip';
import { figureOutline, figureSemanticBounds, realiseFigureContour } from './figures';
import type { PathOp, Vec2 } from './path';
import { pointPath, regionPath } from './pick';
import type { PathPickOptions } from './pick';
import { styleGeometryMetrics } from './styleMetrics';
import type { KindGeometry, NarrowResult } from './types';
import { DashWalker, DotWalker, dashPath, dotPath, drawPath } from './variants';

export interface FigurePaintPath {
    readonly ops: readonly PathOp[];
    readonly role: 'fill' | 'outline' | 'mark';
    readonly fill: Fill;
    readonly width: number;
}
export interface PositionedFigureText { readonly paint: TextPaint; readonly x: number; readonly y: number }
export interface FigureAttachmentSurface { readonly outline: readonly PathOp[]; readonly logicalBox: Rect }
export interface FigureGeometryOptions {
    readonly key: string;
    readonly kernelVersion: number;
    readonly pathError: number;
    readonly lengthError: number;
    readonly maxPieces: number;
    readonly hitMarginCss: number;
    readonly hitErrorCss: number;
    readonly label: PositionedFigureText | null;
}
export type FigureGeometry = KindGeometry<FigurePaintPath, PositionedFigureText, FigureAttachmentSurface>;

/** Restrict hatch work to a visible local region; export can enumerate regions in tiles. */
export function* figureHatch(geometry: FigureGeometry, node: Readonly<FigureNode>, bounds: Rect,
    angle: number, spacing: number, phase: number, maxLines: number, maxSegments: number): Generator<HatchLine> {
    if (!geometry.attachments) throw new RangeError('Figure outline is unavailable');
    const clipped = new ContourClipper([geometry.attachments.outline], maxSegments);
    const orientation = reflectHatch(angle, phase, node.w, node.h + node.growY, node.flipX, node.flipY);
    yield* hatchLines(clipped, bounds, orientation.angle, spacing, orientation.phase, maxLines);
}

export function figureSceneBounds(geometry: FigureGeometry): Readonly<{ ink: Box; hit: Box }> {
    const box = (r: Rect): Box => [r.x, r.y, r.x + r.width, r.y + r.height];
    return { ink: box(geometry.inkBoundsLocal), hit: box(geometry.selectBoundsLocal) };
}

function union(a: Rect | null, b: Rect): Rect {
    if (!a) return b;
    const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y);
    return { x, y, width: Math.max(a.x + a.width, b.x + b.width) - x, height: Math.max(a.y + a.height, b.y + b.height) - y };
}
function textBounds(label: PositionedFigureText): Rect {
    return { x: label.x + label.paint.ink.x, y: label.y + label.paint.ink.y,
        width: label.paint.ink.width, height: label.paint.ink.height };
}
function rectPath(rect: Rect): readonly PathOp[] {
    const { x, y, width: w, height: h } = rect;
    return [{ op: 'M', p: { x, y } }, { op: 'L', p: { x: x + w, y } }, { op: 'L', p: { x: x + w, y: y + h } },
        { op: 'L', p: { x, y: y + h } }, { op: 'Z' }];
}
function pathBounds(ops: readonly PathOp[]): Rect | null {
    let result: Rect | null = null, current: Vec2 | undefined, start: Vec2 | undefined;
    const point = (p: Vec2): void => { result = union(result, { x: p.x, y: p.y, width: 0, height: 0 }); };
    for (const op of ops) {
        if (op.op === 'M') { current = start = op.p; point(op.p); }
        else if (op.op === 'Z') { if (start) { point(start); current = start; } }
        else if (op.op === 'C') {
            if (!current) throw new RangeError('Figure path must start with M');
            const box = cubicBounds({ p0: current, p1: op.c1, p2: op.c2, p3: op.p });
            result = union(result, { x: box[0], y: box[1], width: box[2] - box[0], height: box[3] - box[1] }); current = op.p;
        } else { point(op.p); current = op.p; }
    }
    return result;
}
function expand(rect: Rect, radius: number): Rect {
    return { x: rect.x - radius, y: rect.y - radius, width: rect.width + 2 * radius, height: rect.height + 2 * radius };
}

/** Figure paint, attachment and hit geometry are derived from the same realized contours. */
export function prepareFigureGeometry(node: Readonly<FigureNode>, options: FigureGeometryOptions): FigureGeometry {
    const { pathError, lengthError, maxPieces, hitMarginCss, hitErrorCss, label } = options;
    const height = node.h + node.growY;
    if (![node.w, height, node.width, pathError, lengthError, hitMarginCss, hitErrorCss].every(Number.isFinite)
        || node.w < 0 || height < 0 || node.width < 0 || pathError <= 0 || lengthError <= 0 || hitMarginCss < 0
        || hitErrorCss <= 0 || !Number.isSafeInteger(maxPieces) || maxPieces < 1) throw new RangeError('Invalid figure geometry request');
    const outline = figureOutline(node.shape, node.w, height, node.flipX, node.flipY);
    const semantic = Array.from(realiseFigureContour(outline.primary, pathError, maxPieces));
    const sources = [semantic, ...outline.marks];
    let used = 0;
    const bounded = (ops: Iterable<PathOp>): readonly PathOp[] => {
        const result: PathOp[] = [];
        for (const op of ops) {
            if (++used > maxPieces) throw new RangeError('Figure realization budget exhausted');
            result.push(op);
        }
        return result;
    };
    const baseWidth = styleGeometryMetrics.actualWidth('figure', node.size, 1);
    const style = { nodeId: node.id, kernelVersion: options.kernelVersion, width: node.width,
        referenceWidth: baseWidth, boxWidth: node.w, boxHeight: height };
    const drawn = node.dash === 'draw' ? sources.map(path => bounded(drawPath(path, style, lengthError, maxPieces))) : sources;
    const metrics = node.width > 0 && (node.dash === 'dashed' || node.dash === 'dotted') ? styleGeometryMetrics.dash(node.width) : null;
    const strokes = node.dash === 'none' ? [] : drawn.map(path => {
        if (node.dash === 'dashed' && metrics) return bounded(dashPath(path, new DashWalker(metrics.lengths), lengthError, maxPieces));
        if (node.dash === 'dotted' && metrics) return bounded(dotPath(path, new DotWalker(metrics.dotSpacing), lengthError, maxPieces));
        return path;
    });
    const paths: FigurePaintPath[] = [];
    const interior = node.dash === 'draw' ? drawn[0] : semantic;
    if (node.fill !== 'none') paths.push({ ops: interior, role: 'fill', fill: node.fill, width: 0 });
    for (let i = 0; i < strokes.length; i++) paths.push({ ops: strokes[i], role: i === 0 ? 'outline' : 'mark', fill: 'none', width: node.width });
    const selectBounds = node.dash === 'draw' ? pathBounds(interior) ?? figureSemanticBounds(node.shape, node.w, height, node.flipX, node.flipY)
        : figureSemanticBounds(node.shape, node.w, height, node.flipX, node.flipY);
    let ink: Rect | null = node.fill === 'none' ? null : selectBounds, select: Rect = selectBounds;
    for (const stroke of strokes) {
        const b = pathBounds(stroke);
        if (b) { const painted = expand(b, node.width / 2); ink = union(ink, painted); select = union(select, painted); }
    }
    const textBox = label ? textBounds(label) : null;
    if (textBox) {
        if (![textBox.x, textBox.y, textBox.width, textBox.height].every(Number.isFinite) || textBox.width < 0 || textBox.height < 0) throw new RangeError('Invalid figure label bounds');
        ink = union(ink, textBox); select = union(select, textBox);
    }
    const boxLocal = { x: 0, y: 0, width: node.w, height };
    const optionsForBody: PathPickOptions = { interiorPaths: [interior],
        strokeRadiusLocal: node.dash === 'none' ? 0 : node.width / 2, marginCss: hitMarginCss, errorCss: hitErrorCss, maxSegments: maxPieces };
    const labelPath = textBox ? rectPath(textBox) : null;
    const labelOptions: PathPickOptions = { interiorPaths: labelPath ? [labelPath] : [], strokeRadiusLocal: 0,
        marginCss: 0, errorCss: hitErrorCss, maxSegments: maxPieces };
    const none: NarrowResult = { hit: false, distanceCss: Infinity, part: 'none' };
    return {
        key: options.key, boxLocal, inkBoundsLocal: ink ?? { x: 0, y: 0, width: 0, height: 0 }, selectBoundsLocal: select,
        paths, text: label ? [label] : [], attachments: { outline: interior, logicalBox: boxLocal },
        point(query) {
            if (labelPath && pointPath([], query, labelOptions).hit) return { hit: true, distanceCss: 0, part: 'label' };
            const result = pointPath(strokes, query, optionsForBody);
            return result.hit ? { ...result, part: 'body' } : none;
        },
        region(query) {
            if (labelPath && regionPath([], query, labelOptions).hit) return { hit: true, distanceCss: 0, part: 'label' };
            const result = regionPath(strokes, query, optionsForBody);
            return result.hit ? { ...result, part: 'body' } : none;
        },
    };
}
