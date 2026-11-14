import type { Affine, PathCommand, Rect } from '../../platform/types';
import type { ClipNode, EmbedNode, FigureNode, FrameNode, LinkcardNode, PictureNode, StickyNode, TextNode } from '../model/nodes';
import type { InkCoverage } from '../ink/outline';
import { InkPickJob } from '../ink/pick';
import type { InkPickQuery } from '../ink/pick';
import type { Fill } from '../model/styles';
import type { TextLayoutRequest, TextPaint } from '../text/paint';
import { transformPoint } from './affine';
import { cubicBounds } from './bounds';
import type { Box } from './bounds';
import { ContourClipper, hatchLines, reflectHatch } from './clip';
import type { HatchLine } from './clip';
import { ellipseArcPath, figureOutline, figureSemanticBounds, realiseFigureContour } from './figures';
import type { PathOp, Vec2 } from './path';
import { pointPath, regionPath } from './pick';
import type { PathPickOptions } from './pick';
import { styleGeometryMetrics } from './styleMetrics';
import type { KindGeometry, NarrowResult } from './types';
import { DashWalker, DotWalker, dashPath, dotPath, drawPath } from './variants';

/** Translate the engine's retained path into the platform paint/export command vocabulary. */
export function* pathCommands(ops: Iterable<PathOp>): Generator<PathCommand> {
    for (const op of ops) {
        if (op.op === 'Z') yield ['Z'];
        else if (op.op === 'C') yield ['C', op.c1.x, op.c1.y, op.c2.x, op.c2.y, op.p.x, op.p.y];
        else if (op.op === 'M') yield ['M', op.p.x, op.p.y];
        else yield ['L', op.p.x, op.p.y];
    }
}

export interface FigurePaintPath {
    readonly ops: readonly PathOp[];
    readonly role: 'fill' | 'outline' | 'mark';
    readonly fill: Fill;
    readonly width: number;
}
export interface PositionedFigureText { readonly paint: TextPaint; readonly x: number; readonly y: number; readonly scale?: number }
export interface FigureAttachmentSurface { readonly outline: readonly PathOp[]; readonly logicalBox: Rect }
const FIGURE_LABEL_SIZE = { s: 18, m: 22, l: 26, xl: 32 } as const;

/** Text layout remains text-owned; this only supplies the figure's host constraints. */
export function figureLabelRequest(node: Readonly<FigureNode>, revision: string, fontEpoch: number):
    Readonly<{ request: TextLayoutRequest; x: number; y: number }> | null {
    if (!node.label) return null;
    const inset = node.width / 2;
    const width = Math.max(0, node.w - 2 * inset), height = Math.max(0, node.h + node.growY - 2 * inset);
    if (![inset, width, height, node.labelScale, fontEpoch].every(Number.isFinite) || inset < 0 || node.labelScale <= 0) throw new RangeError('Invalid figure label layout');
    const align = node.align.startsWith('start') ? 'start' : node.align.startsWith('end') ? 'end' : 'middle';
    return { x: inset, y: inset, request: { text: node.label, revision, fontEpoch, width,
        style: { font: node.font, size: FIGURE_LABEL_SIZE[node.size] * node.labelScale,
            ink: { swatch: node.labelColor, role: 'label' }, align, verticalAlign: node.valign,
            padding: { top: 16, right: 16, bottom: 16, left: 16 }, minHeight: height, overflow: 'grapheme' } } };
}

export function stickyLabelRequest(node: Readonly<StickyNode>, revision: string, fontEpoch: number):
    Readonly<{ request: TextLayoutRequest; scale: number }> {
    if (![node.scale, node.growY, fontEpoch].every(Number.isFinite) || node.scale < 0 || node.growY < 0) throw new RangeError('Invalid sticky label layout');
    const align = node.align.startsWith('start') ? 'start' : node.align.startsWith('end') ? 'end' : 'middle';
    const fit = node.fit ?? 1;
    if (!Number.isFinite(fit) || fit <= 0) throw new RangeError('Invalid sticky text fit');
    return { scale: node.scale, request: { text: node.text, revision, fontEpoch, width: 200,
        style: { font: node.font, size: FIGURE_LABEL_SIZE[node.size] * fit, ink: { swatch: node.labelColor, role: 'label' },
            align, verticalAlign: node.valign, padding: { top: 16, right: 16, bottom: 16, left: 16 },
            minHeight: 200 + node.growY, overflow: 'shrink' } } };
}

/** Frame titles are laid out as text, not a second editable content format. */
export function frameTitleRequest(node: Readonly<FrameNode>, fallback: string, revision: string,
    fontEpoch: number, zoom: number): TextLayoutRequest {
    if (!Number.isFinite(zoom) || zoom <= 0 || !Number.isFinite(node.w) || node.w < 0 || !Number.isFinite(fontEpoch)) throw new RangeError('Invalid frame title layout');
    const text = node.name || fallback;
    return { text: { blocks: [{ kind: 'p', level: 0, dir: 'auto', runs: [{ text, marks: {} }] }] },
        revision, fontEpoch, width: node.w, style: { font: 'sans', size: 12 / zoom,
            ink: { swatch: node.color ?? 'black', role: 'label' }, align: 'start', verticalAlign: 'start',
            padding: { top: 0, right: 0, bottom: 0, left: 0 }, minHeight: 0, overflow: 'allow',
            maxLines: 1, ellipsis: true } };
}

export interface FigureGeometryOptions {
    readonly key: string;
    readonly kernelVersion: number;
    readonly fontEpoch: number;
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

export function geometrySceneBounds(geometry: Readonly<{ inkBoundsLocal: Rect; selectBoundsLocal: Rect }>): Readonly<{ ink: Box; hit: Box }> {
    const box = (r: Rect): Box => {
        const right = r.x + r.width, bottom = r.y + r.height;
        if (![r.x, r.y, r.width, r.height, right, bottom].every(Number.isFinite) || r.width < 0 || r.height < 0) throw new RangeError('Invalid scene geometry bounds');
        return [r.x, r.y, right, bottom];
    };
    return { ink: box(geometry.inkBoundsLocal), hit: box(geometry.selectBoundsLocal) };
}
export const figureSceneBounds = geometrySceneBounds;

function union(a: Rect | null, b: Rect): Rect {
    if (!a) return b;
    const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y);
    return { x, y, width: Math.max(a.x + a.width, b.x + b.width) - x, height: Math.max(a.y + a.height, b.y + b.height) - y };
}
function textBounds(label: PositionedFigureText): Rect {
    const scale = label.scale ?? 1;
    if (!Number.isFinite(scale) || scale < 0) throw new RangeError('Invalid text scale');
    return { x: label.x + label.paint.ink.x * scale, y: label.y + label.paint.ink.y * scale,
        width: label.paint.ink.width * scale, height: label.paint.ink.height * scale };
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
export function transformedPathBounds(ops: readonly PathOp[], matrix: Affine): Rect | null {
    if (!matrix.every(Number.isFinite)) throw new RangeError('Invalid path transform');
    const mapped = ops.map((op): PathOp => {
        if (op.op === 'Z') return op;
        if (op.op === 'C') return { op: 'C', c1: transformPoint(matrix, op.c1), c2: transformPoint(matrix, op.c2), p: transformPoint(matrix, op.p) };
        return { op: op.op, p: transformPoint(matrix, op.p) };
    });
    return pathBounds(mapped);
}

export interface FigureWorldBoundsOptions {
    readonly kernelVersion: number; readonly pathError: number; readonly lengthError: number; readonly maxPieces: number;
}

/** Preserve the approximation enclosure so page-centre callers can defer an ambiguous boundary. */
export function figureWorldSemanticBounds(node: Readonly<FigureNode>, matrix: Affine,
    options: FigureWorldBoundsOptions): Readonly<{ bounds: Rect; errorWorld: number }> {
    if (!Number.isFinite(options.pathError) || options.pathError <= 0 || !Number.isFinite(options.lengthError) || options.lengthError <= 0
        || !Number.isSafeInteger(options.maxPieces) || options.maxPieces < 1) throw new RangeError('Invalid figure bounds budget');
    const height = node.h + node.growY;
    const contour = figureOutline(node.shape, node.w, height, node.flipX, node.flipY).primary;
    let paths = Array.from(realiseFigureContour(contour, options.pathError, options.maxPieces));
    if (paths.length > options.maxPieces) throw new RangeError('Figure bounds budget exhausted');
    if (node.dash === 'draw') paths = Array.from(drawPath(paths, { nodeId: node.id, kernelVersion: options.kernelVersion,
        width: node.width, referenceWidth: styleGeometryMetrics.actualWidth('figure', node.size, 1),
        boxWidth: node.w, boxHeight: height }, options.lengthError, options.maxPieces));
    const bounds = transformedPathBounds(paths, matrix);
    if (!bounds) throw new RangeError('Figure has no outline');
    const scale = Math.hypot(matrix[0], matrix[1], matrix[2], matrix[3]);
    const errorWorld = contour.kind === 'path' && node.dash !== 'draw' ? 0 : options.pathError * scale;
    if (!Number.isFinite(errorWorld)) throw new RangeError('Figure bounds error overflows');
    return { bounds: errorWorld ? expand(bounds, errorWorld) : bounds, errorWorld };
}

function expand(rect: Rect, radius: number): Rect {
    return { x: rect.x - radius, y: rect.y - radius, width: rect.width + 2 * radius, height: rect.height + 2 * radius };
}

export interface InkGeometry {
    readonly key: string;
    readonly boxLocal: Rect;
    readonly inkBoundsLocal: Rect;
    readonly selectBoundsLocal: Rect;
    readonly coverage: InkCoverage;
    pickJob(localToSurface: Affine, query: InkPickQuery, dpr: number): InkPickJob;
}

/** Keep long ink coverage leased and let its own resumable picker enforce R-13. */
export function prepareInkGeometry(key: string, coverage: InkCoverage): InkGeometry {
    const rect = (r: Readonly<{ x: number; y: number; w: number; h: number }>): Rect =>
        ({ x: r.x, y: r.y, width: r.w, height: r.h });
    const ink = rect(coverage.boundsLocal), centre = rect(coverage.centrelineBoundsLocal), box = rect(coverage.geometry.boundsLocal);
    if (![ink.x, ink.y, ink.width, ink.height, centre.x, centre.y, centre.width, centre.height,
        box.x, box.y, box.width, box.height].every(Number.isFinite)
        || ink.width < 0 || ink.height < 0 || centre.width < 0 || centre.height < 0 || box.width < 0 || box.height < 0) throw new RangeError('Invalid ink coverage bounds');
    return { key, boxLocal: box, inkBoundsLocal: ink, selectBoundsLocal: union(ink, centre), coverage,
        pickJob(localToSurface, query, dpr) { return new InkPickJob(coverage, localToSurface, query, dpr); } };
}

export interface TextGeometryOptions {
    readonly key: string; readonly fontEpoch: number; readonly hitErrorCss: number; readonly maxSegments: number;
}
export type TextGeometry = KindGeometry<never, PositionedFigureText, FigureAttachmentSurface>;

/** Whitespace remains selectable: text selection follows its layout box, not glyph alpha. */
export function prepareTextGeometry(node: Readonly<TextNode>, paint: TextPaint, options: TextGeometryOptions): TextGeometry | undefined {
    if (paint.fontEpoch !== options.fontEpoch) return undefined;
    if (!Number.isFinite(node.scale) || node.scale < 0 || !Number.isFinite(options.hitErrorCss) || options.hitErrorCss <= 0
        || !Number.isSafeInteger(options.maxSegments) || options.maxSegments < 1) throw new RangeError('Invalid text geometry request');
    const scale = node.scale, box = { x: 0, y: 0, width: paint.box.w * scale, height: paint.box.h * scale };
    const label: PositionedFigureText = { paint, x: 0, y: 0, scale };
    const ink = textBounds(label), outline = rectPath(box);
    let select = box;
    const regions: (readonly PathOp[])[] = [outline];
    for (const decoration of [...paint.backgrounds, ...paint.decorations]) {
        const rect = { x: decoration.x * scale, y: decoration.y * scale, width: decoration.w * scale, height: decoration.h * scale };
        select = union(select, rect); regions.push(rectPath(rect));
    }
    if (![box.width, box.height, ink.x, ink.y, ink.width, ink.height, select.x, select.y, select.width, select.height].every(Number.isFinite)
        || box.width < 0 || box.height < 0 || ink.width < 0 || ink.height < 0) throw new RangeError('Invalid text geometry');
    const pickOptions: PathPickOptions = { interiorPaths: regions, strokeRadiusLocal: 0, marginCss: 0,
        errorCss: options.hitErrorCss, maxSegments: options.maxSegments };
    return { key: options.key, boxLocal: box, inkBoundsLocal: ink, selectBoundsLocal: select, paths: [], text: [label],
        attachments: { outline, logicalBox: box },
        point(query) { return pointPath([], query, pickOptions); },
        region(query) { return regionPath([], query, pickOptions); } };
}

export interface ContainerPath { readonly ops: readonly PathOp[]; readonly role: 'surface' | 'outline'; readonly width: number }
export interface ContainerGeometryOptions {
    readonly key: string; readonly fontEpoch: number; readonly pathError: number; readonly maxPieces: number;
    readonly hitMarginCss: number; readonly hitErrorCss: number;
    readonly text: PositionedFigureText | null;
}
export type ContainerGeometry = KindGeometry<ContainerPath, PositionedFigureText, FigureAttachmentSurface>;

function roundedBox(width: number, height: number, radius: number, error: number, maxPieces: number): readonly PathOp[] {
    const r = Math.min(radius, width / 2, height / 2);
    if (r === 0) return rectPath({ x: 0, y: 0, width, height });
    const result: PathOp[] = [];
    const add = (ops: Iterable<PathOp>): void => {
        for (const op of ops) { if (result.length >= maxPieces) throw new RangeError('Rounded box budget exhausted'); result.push(op); }
    };
    add(ellipseArcPath(width - r, r, r, r, -Math.PI / 2, Math.PI / 2, error, maxPieces));
    add([{ op: 'L', p: { x: width, y: height - r } }]);
    add(ellipseArcPath(width - r, height - r, r, r, 0, Math.PI / 2, error, maxPieces, false));
    add([{ op: 'L', p: { x: r, y: height } }]);
    add(ellipseArcPath(r, height - r, r, r, Math.PI / 2, Math.PI / 2, error, maxPieces, false));
    add([{ op: 'L', p: { x: 0, y: r } }]);
    add(ellipseArcPath(r, r, r, r, Math.PI, Math.PI / 2, error, maxPieces, false));
    add([{ op: 'Z' }]);
    return result;
}

function containerGeometry(box: Rect, outline: readonly PathOp[], border: number, selectInterior: boolean,
    options: ContainerGeometryOptions): ContainerGeometry {
    const { text, key, hitErrorCss, hitMarginCss, maxPieces } = options;
    if (![box.x, box.y, box.width, box.height, border, hitErrorCss, hitMarginCss].every(Number.isFinite)
        || box.width < 0 || box.height < 0 || border < 0 || hitErrorCss <= 0 || hitMarginCss < 0
        || !Number.isSafeInteger(maxPieces) || maxPieces < 1) throw new RangeError('Invalid container geometry request');
    const body = border ? expand(box, border / 2) : box;
    const textBox = text ? textBounds(text) : null;
    if (textBox && (![textBox.x, textBox.y, textBox.width, textBox.height].every(Number.isFinite) || textBox.width < 0 || textBox.height < 0)) {
        throw new RangeError('Invalid container text bounds');
    }
    const allBounds = textBox ? union(body, textBox) : body;
    const textPath = textBox ? rectPath(textBox) : null;
    const bodyOptions: PathPickOptions = { interiorPaths: selectInterior ? [outline] : [], strokeRadiusLocal: border / 2,
        marginCss: hitMarginCss, errorCss: hitErrorCss, maxSegments: maxPieces };
    const textOptions: PathPickOptions = { interiorPaths: textPath ? [textPath] : [], strokeRadiusLocal: 0,
        marginCss: 0, errorCss: hitErrorCss, maxSegments: maxPieces };
    const paths: ContainerPath[] = [{ ops: outline, role: selectInterior ? 'surface' : 'outline', width: border }];
    return { key, boxLocal: box, inkBoundsLocal: allBounds, selectBoundsLocal: allBounds, paths, text: text ? [text] : [],
        attachments: { outline, logicalBox: box },
        point(query) {
            if (textPath && pointPath([], query, textOptions).hit) return { hit: true, distanceCss: 0, part: selectInterior ? 'label' : 'title' };
            return pointPath([outline], query, bodyOptions);
        },
        region(query) {
            const body = regionPath([outline], query, bodyOptions);
            if (!textPath) return body;
            const textHit = regionPath([], query, textOptions);
            if (query.kind === 'polygon' && query.containment) return body.hit && textHit.hit ? body : { hit: false, distanceCss: Infinity, part: 'none' };
            return textHit.hit ? { hit: true, distanceCss: 0, part: selectInterior ? 'label' : 'title' } : body;
        } };
}

export function prepareStickyGeometry(node: Readonly<StickyNode>, options: ContainerGeometryOptions & Readonly<{ cornerRadius?: number }>): ContainerGeometry | undefined {
    if (!options.text || options.text.paint.fontEpoch !== options.fontEpoch) return undefined;
    const width = 200 * node.scale, height = (200 + node.growY) * node.scale;
    const radius = options.cornerRadius ?? styleGeometryMetrics.stickyCornerRadius(node.scale).value;
    if (!Number.isFinite(radius) || radius < 0) throw new RangeError('Invalid sticky radius');
    const outline = roundedBox(width, height, radius, options.pathError, options.maxPieces);
    return containerGeometry({ x: 0, y: 0, width, height }, outline, 0, true, options);
}

export function prepareFrameGeometry(node: Readonly<FrameNode>, options: ContainerGeometryOptions & Readonly<{ borderWidth?: number }>): ContainerGeometry | undefined {
    if (!options.text || options.text.paint.fontEpoch !== options.fontEpoch) return undefined;
    const box = { x: 0, y: 0, width: node.w, height: node.h };
    return containerGeometry(box, rectPath(box), options.borderWidth ?? styleGeometryMetrics.frameBorderWidth().value, false, options);
}

export type MediaBoxNode = PictureNode | ClipNode | LinkcardNode | EmbedNode;
export function prepareMediaBoxGeometry(node: Readonly<MediaBoxNode>, options: ContainerGeometryOptions): ContainerGeometry | undefined {
    if (options.text && options.text.paint.fontEpoch !== options.fontEpoch) return undefined;
    const box = { x: 0, y: 0, width: node.w, height: node.h };
    const circular = node.kind === 'picture' && node.crop?.circle;
    const outline = circular ? Array.from(realiseFigureContour(figureOutline('ellipse', node.w, node.h, false, false).primary,
        options.pathError, options.maxPieces)) : rectPath(box);
    return containerGeometry(box, outline, 0, true, options);
}

/** Figure paint, attachment and hit geometry are derived from the same realized contours. */
export function prepareFigureGeometry(node: Readonly<FigureNode>, options: FigureGeometryOptions): FigureGeometry | undefined {
    const { pathError, lengthError, maxPieces, hitMarginCss, hitErrorCss, label } = options;
    if ((!node.label && label) || (node.label && (!label || label.paint.fontEpoch !== options.fontEpoch))) return undefined;
    const height = node.h + node.growY;
    if (![node.w, height, node.width, pathError, lengthError, hitMarginCss, hitErrorCss].every(Number.isFinite)
        || node.w < 0 || height < 0 || node.width < 0 || pathError <= 0 || lengthError <= 0 || hitMarginCss < 0
        || hitErrorCss <= 0 || !Number.isSafeInteger(maxPieces) || maxPieces < 1) throw new RangeError('Invalid figure geometry request');
    const outline = figureOutline(node.shape, node.w, height, node.flipX, node.flipY);
    const semantic = Array.from(realiseFigureContour(outline.primary, pathError, maxPieces));
    if (semantic.length > maxPieces) throw new RangeError('Figure realization budget exhausted');
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
            const result = regionPath(strokes, query, optionsForBody);
            if (!labelPath) return result.hit ? { ...result, part: 'body' } : none;
            const labelHit = regionPath([], query, labelOptions);
            if (query.kind === 'polygon' && query.containment) return result.hit && labelHit.hit ? { ...result, part: 'body' } : none;
            return labelHit.hit ? { hit: true, distanceCss: 0, part: 'label' } : result.hit ? { ...result, part: 'body' } : none;
        },
    };
}
