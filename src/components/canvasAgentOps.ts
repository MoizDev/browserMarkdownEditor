// The AI agent's hands on a tldraw canvas — a `.tldraw` drawing, a `.notebook`,
// or a PDF's annotation layer — and the shape summaries it reads them through.
//
// Imports tldraw, so it is imported ONLY by the three canvas panes (DrawingPane,
// NotebookPane, PdfAnnotateCanvas), which are lazy chunks. App and utils reach
// it through the `CanvasAgentOps` object a pane registers in utils/viewRegistry.ts,
// never by importing this file: one static import from the main bundle would
// pull all of tldraw into it (see the pdf-and-drawings skill).
//
// Every op arrives as untrusted JSON from an agent. It is validated here in
// full — types, finiteness, magnitudes, point counts, which shapes it may touch
// — whatever the JSON schema the helper served promised, because the schema is
// advice to the model and this is the only gate.
//
// ONE undo step: `markHistoryStoppingPoint` then a single `editor.run`, so ⌘Z
// takes back the agent's whole change. And NOT a remote merge: changes made
// through the editor API outside `mergeRemoteChanges` reach the store as
// `source: 'user'` (@tldraw/store Store.mjs: `isMergingRemoteChanges ? "remote"
// : "user"`), which is exactly what each pane's save listener
// (`{source: 'user', scope: 'document'}`) serializes — so an agent's edit is
// dirtied, autosaved, and (for a PDF) rebuilt from the pristine original by the
// same path a pen stroke takes. Nothing here saves anything itself.

import {
    Box,
    b64Vecs,
    createShapeId,
    getArrowBindings,
    getIndices,
    renderPlaintextFromRichText,
    toRichText,
} from 'tldraw';
import type {
    Editor,
    TLArrowShape,
    TLDefaultColorStyle,
    TLDefaultDashStyle,
    TLDefaultFillStyle,
    TLDefaultSizeStyle,
    TLGeoShapeGeoStyle,
    TLLineShapePoint,
    TLRichText,
    TLShape,
    TLShapeId,
    TLShapePartial,
    VecModel,
} from 'tldraw';
import type { CanvasAgentOps, CanvasApplyResult, ShapeSummary } from '../utils/viewRegistry';
import { pageAt, type PageBox } from './pagedCanvas';

/** What a canvas tells the ops about its pages. A drawing has none. */
export interface CanvasPageModel {
    /** The page stack in canvas coordinates, top to bottom; `[]` for a drawing,
     *  whose coordinates are the canvas's own. Read on every call, so a stack
     *  that grows is followed. */
    boxes(): readonly PageBox[];
    /** 0-based page the user is looking at — where an op without `page` lands. */
    currentPage(): number;
    /** A page backdrop (the ruled paper, a PDF page): never listed, never
     *  touched, whatever id the agent names. */
    isBackdrop(id: TLShapeId): boolean;
    /** Notebook only: make sure at least `count` pages exist (the notebook
     *  grows downward, as it does under the pen). Returns the page count now,
     *  which is less than `count` at the notebook's page cap. */
    ensurePages?(count: number): number;
}

/* ── Limits ────────────────────────────────────────────────────────────────
   A coordinate past MAX_COORD is not a place anyone meant; a shape wider than
   MAX_SIZE would be unfindable on screen. MAX_POINTS mirrors the schema's
   `maxItems`; MAX_OPS its `maxItems` for the batch. */
const MAX_OPS = 200;
const MAX_COORD = 1e6;
const MAX_SIZE = 20_000;
const MIN_SIZE = 1;
const MAX_POINTS = 5000;
const MAX_TEXT = 10_000;
/** How far past its last page one op may grow a notebook. */
const MAX_PAGES_GROWN = 5;
/** In summaries: enough to recognise a note, not a dump of one. */
const SUMMARY_TEXT = 2000;
/** Float16 deltas (how tldraw 5 stores a stroke) lose precision fast: at a
 *  512-unit jump the step is 0.25. Densifying a sparse polyline to this step
 *  keeps every stored point within a hundredth of where the agent put it —
 *  and keeps the freehand renderer, which smooths between samples, on the
 *  straight segments the agent actually described. */
const DRAW_STEP = 8;

const COLORS: ReadonlySet<string> = new Set([
    'black', 'grey', 'light-violet', 'violet', 'blue', 'light-blue', 'yellow',
    'orange', 'green', 'light-green', 'light-red', 'red', 'white',
]);
const SIZES: ReadonlySet<string> = new Set(['s', 'm', 'l', 'xl']);
const FILLS: ReadonlySet<string> = new Set(['none', 'semi', 'solid', 'pattern']);
const DASHES: ReadonlySet<string> = new Set(['draw', 'solid', 'dashed', 'dotted']);
/** tldraw 5.2.4's GeoShapeGeoStyle values (tlschema TLGeoShape.mjs). */
const GEOS: ReadonlySet<string> = new Set([
    'cloud', 'rectangle', 'ellipse', 'triangle', 'diamond', 'pentagon', 'hexagon',
    'octagon', 'star', 'rhombus', 'rhombus-2', 'oval', 'trapezoid', 'arrow-right',
    'arrow-left', 'arrow-up', 'arrow-down', 'x-box', 'check-box', 'heart',
]);
const ALIGNS: ReadonlySet<string> = new Set(['start', 'middle', 'end']);

/** A refusal of ONE op, reported in `errors` while the rest of the batch goes on. */
class OpError extends Error {}

type Json = Record<string, unknown>;

const isObject = (value: unknown): value is Json => !!value && typeof value === 'object' && !Array.isArray(value);
const round1 = (value: number) => Math.round(value * 10) / 10;

function num(value: unknown, name: string): number {
    if (typeof value !== 'number' || !Number.isFinite(value)) throw new OpError(`${name} must be a finite number`);
    if (Math.abs(value) > MAX_COORD) throw new OpError(`${name} is out of range (|${name}| ≤ ${MAX_COORD})`);
    return value;
}

function optNum(value: unknown, name: string): number | undefined {
    return value === undefined ? undefined : num(value, name);
}

function size(value: unknown, name: string): number {
    const n = num(value, name);
    if (n <= 0) throw new OpError(`${name} must be greater than 0`);
    return Math.min(MAX_SIZE, Math.max(MIN_SIZE, n));
}

function text(value: unknown, name: string, allowEmpty = false): string {
    if (typeof value !== 'string') throw new OpError(`${name} must be a string`);
    if (!allowEmpty && !value.trim()) throw new OpError(`${name} is empty`);
    if (value.length > MAX_TEXT) throw new OpError(`${name} is longer than ${MAX_TEXT} characters`);
    return value;
}

function oneOf<T extends string>(value: unknown, allowed: ReadonlySet<string>, name: string): T | undefined {
    if (value === undefined) return undefined;
    if (typeof value !== 'string' || !allowed.has(value)) {
        throw new OpError(`${name} must be one of: ${[...allowed].join(', ')}`);
    }
    return value as T;
}

/** Degrees → radians, normalised into (-π, π]. */
function radians(value: unknown, name: string): number {
    const degrees = num(value, name);
    let r = ((degrees % 360) * Math.PI) / 180;
    if (r > Math.PI) r -= 2 * Math.PI;
    if (r <= -Math.PI) r += 2 * Math.PI;
    return r;
}

/** The page a shape belongs to: the one under its vertical centre (a gap
 *  counts as the page after it, as `pageAt` has it). */
function pageOfBounds(boxes: readonly PageBox[], bounds: Box): number {
    return pageAt(boxes, (bounds.minY + bounds.maxY) / 2);
}

function plainText(editor: Editor, richText: unknown): string | undefined {
    if (!richText || typeof richText !== 'object') return undefined;
    try {
        const out = renderPlaintextFromRichText(editor, richText as TLRichText).trim();
        if (!out) return undefined;
        return out.length > SUMMARY_TEXT ? `${out.slice(0, SUMMARY_TEXT)}…` : out;
    } catch {
        return undefined;
    }
}

/** One shape as the agent sees it (see ShapeSummary). Null for a shape with no
 *  bounds, which has nowhere to be. */
export function summarizeShape(editor: Editor, model: CanvasPageModel, shape: TLShape): ShapeSummary | null {
    const bounds = editor.getShapePageBounds(shape.id);
    if (!bounds) return null;
    const boxes = model.boxes();
    let x = bounds.x;
    let y = bounds.y;
    let page: number | undefined;
    if (boxes.length > 0) {
        const i = pageOfBounds(boxes, bounds);
        page = i + 1;
        x -= boxes[i].x;
        y -= boxes[i].y;
    }
    const summary: ShapeSummary = { id: shape.id, type: shape.type, x: round1(x), y: round1(y), w: round1(bounds.w), h: round1(bounds.h) };
    if (page !== undefined) summary.page = page;
    const rotation = (editor.getShapePageTransform(shape.id).rotation() * 180) / Math.PI;
    if (Math.abs(rotation) > 0.05) summary.rotation = round1(rotation);
    const props = shape.props as Json;
    if (typeof props.geo === 'string') summary.geo = props.geo;
    if (typeof props.color === 'string') summary.color = props.color;
    if (typeof props.fill === 'string') summary.fill = props.fill;
    if (typeof props.dash === 'string') summary.dash = props.dash;
    if (typeof props.size === 'string') summary.size = props.size;
    const label = plainText(editor, props.richText);
    if (label) summary.text = label;
    if (shape.type === 'arrow') {
        const bindings = getArrowBindings(editor, shape as TLArrowShape);
        if (bindings.start) summary.startShapeId = bindings.start.toId;
        if (bindings.end) summary.endShapeId = bindings.end.toId;
    }
    return summary;
}

/** The agent's shapes: every shape on the current tldraw page except the
 *  backdrops, bottom to top. */
function agentShapes(editor: Editor, model: CanvasPageModel): TLShape[] {
    return editor.getCurrentPageShapesSorted().filter(s => !model.isBackdrop(s.id));
}

/**
 * Summaries of the shapes `keep` accepts, capped at `cap`, with the full count.
 * What a pane's `describe()` reports for the part of the canvas on screen.
 */
export function summarizeShapes(
    editor: Editor,
    model: CanvasPageModel,
    keep: (bounds: Box, shape: TLShape) => boolean,
    cap = 200,
): { shapes: ShapeSummary[]; total: number } {
    const shapes: ShapeSummary[] = [];
    let total = 0;
    for (const shape of agentShapes(editor, model)) {
        const bounds = editor.getShapePageBounds(shape.id);
        if (!bounds || !keep(bounds, shape)) continue;
        total++;
        if (shapes.length >= cap) continue;
        const summary = summarizeShape(editor, model, shape);
        if (summary) shapes.push(summary);
    }
    return { shapes, total };
}

/** The user's selection, backdrops excluded (a locked page can still be
 *  selected by a click on it). */
export function selectedAgentShapeIds(editor: Editor, model: CanvasPageModel): string[] {
    return editor.getSelectedShapeIds().filter(id => !model.isBackdrop(id));
}

/** 1-based pages at least partly inside `view`. */
export function pagesInView(boxes: readonly PageBox[], view: Box): number[] {
    const out: number[] = [];
    for (let i = pageAt(boxes, view.minY); i < boxes.length && boxes[i].y < view.maxY; i++) {
        if (boxes[i].y + boxes[i].height > view.minY) out.push(i + 1);
    }
    return out;
}

/** 0-based page taking up the most of `view` — the page the user is looking
 *  at, which is where an op that names no page lands. Not the page under the
 *  top edge: scrolled nine-tenths of the way through page 2, the reader is
 *  looking at page 3. */
export function dominantPage(boxes: readonly PageBox[], view: Box): number {
    let best = 0;
    let bestArea = -1;
    for (let i = pageAt(boxes, view.minY); i < boxes.length && boxes[i].y < view.maxY; i++) {
        const b = boxes[i];
        const w = Math.min(b.x + b.width, view.maxX) - Math.max(b.x, view.minX);
        const h = Math.min(b.y + b.height, view.maxY) - Math.max(b.y, view.minY);
        const area = Math.max(0, w) * Math.max(0, h);
        if (area > bestArea) { bestArea = area; best = i; }
    }
    return Math.min(best, Math.max(0, boxes.length - 1));
}

/** A white PNG — what an empty region looks like (tldraw's export refuses to
 *  build an image with no shapes in it). */
export async function blankPng(width: number, height: number): Promise<Blob | null> {
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(width));
    canvas.height = Math.max(1, Math.round(height));
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    return new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
}

/**
 * A PNG of one region of the canvas, long side ≤ `maxSide` px, as it looks on
 * screen minus the chrome: every shape touching it — page backdrops included,
 * so ruled paper and PDF pages are there — over the canvas background.
 *
 * `darkMode: false` always, like every export in the app: a page is white in
 * either theme, and a whiteboard read by a model is clearer as black on white
 * than as the dark theme's near-white on near-black.
 *
 * `maxScale` keeps a small region from being blown up past what the screen
 * shows (a viewport is captured at no more than twice its on-screen size).
 */
export async function captureRegion(editor: Editor, bounds: Box, maxSide: number, maxScale = Infinity): Promise<Blob | null> {
    if (!(bounds.w > 0 && bounds.h > 0) || !(maxSide > 0)) return null;
    const scale = Math.min(maxScale, maxSide / Math.max(bounds.w, bounds.h));
    const ids = [...editor.getCurrentPageShapeIds()].filter(id => {
        const b = editor.getShapePageBounds(id);
        return !!b && Box.Collides(b, bounds);
    });
    if (ids.length === 0) return blankPng(bounds.w * scale, bounds.h * scale);
    try {
        const { blob } = await editor.toImage(ids, {
            bounds,
            scale,
            pixelRatio: 1,
            padding: 0,
            background: true,
            darkMode: false,
            format: 'png',
        });
        return blob;
    } catch (err) {
        console.warn('Could not capture the canvas for the agent:', err);
        return null;
    }
}

/**
 * The agent's canvas ops for one live editor. `model` supplies the pages (or
 * none) and which shapes are backdrop; both are read per call, so the object
 * stays valid while the notebook grows or the pages stream in.
 */
export function createCanvasAgentOps(editor: Editor, model: CanvasPageModel): CanvasAgentOps {
    const paged = () => model.boxes().length > 0;

    /** The box of 0-based page `index`, growing a notebook to reach it — by a
     *  few pages at most: a page number far past the end is a mistake, and
     *  honouring it would append a stack of blank pages. */
    const pageBox = (index: number): PageBox => {
        let boxes = model.boxes();
        if (index >= boxes.length && index < boxes.length + MAX_PAGES_GROWN && model.ensurePages) {
            model.ensurePages(index + 1);
            boxes = model.boxes();
        }
        if (index < 0 || index >= boxes.length) {
            throw new OpError(`there is no page ${index + 1} (the document has ${boxes.length} ${boxes.length === 1 ? 'page' : 'pages'})`);
        }
        return boxes[index];
    };

    /** The 0-based page an op's `page` names, or the user's. */
    const targetPage = (op: Json): number => {
        if (op.page === undefined) return model.currentPage();
        const page = op.page;
        if (typeof page !== 'number' || !Number.isInteger(page) || page < 1) throw new OpError('page must be an integer ≥ 1');
        return page - 1;
    };

    /**
     * A point from the agent, in canvas coordinates. On pages it is
     * page-relative and CLAMPED onto the page — the camera is locked to the page
     * stack, so a point off the page would be a shape the user could never
     * scroll to; `notes` records that it happened.
     */
    const toCanvas = (box: PageBox | null, x: number, y: number, notes: Set<string>): VecModel => {
        if (!box) return { x, y };
        const cx = Math.min(box.width, Math.max(0, x));
        const cy = Math.min(box.height, Math.max(0, y));
        if (cx !== x || cy !== y) notes.add('moved onto the page (coordinates are page-relative, 0..width × 0..height)');
        return { x: box.x + cx, y: box.y + cy };
    };

    /** A shape the agent may touch, by the id it gave (with or without the
     *  `shape:` prefix), or `$N` for the shape op N of this batch created. */
    const resolveShape = (raw: unknown, createdByOp: Map<number, TLShapeId>, name: string): TLShape => {
        if (typeof raw !== 'string' || !raw) throw new OpError(`${name} must be a shape id`);
        let id: TLShapeId;
        const ref = /^\$(\d+)$/.exec(raw);
        if (ref) {
            const made = createdByOp.get(Number(ref[1]));
            if (!made) throw new OpError(`${name} ${raw}: op ${ref[1]} created no shape`);
            id = made;
        } else {
            id = (raw.startsWith('shape:') ? raw : `shape:${raw}`) as TLShapeId;
        }
        const shape = editor.getShape(id);
        if (!shape || editor.getAncestorPageId(shape) !== editor.getCurrentPageId()) throw new OpError(`no shape ${raw}`);
        if (model.isBackdrop(shape.id)) throw new OpError(`${raw} is part of the page itself and cannot be changed`);
        return shape;
    };

    const assertUnlocked = (shape: TLShape, raw: string) => {
        if (editor.isShapeOrAncestorLocked(shape)) throw new OpError(`${raw} is locked`);
    };

    /** Validated points in canvas coordinates, with pressure when given. */
    const readPoints = (value: unknown, box: PageBox | null, notes: Set<string>): { points: VecModel[]; pressure: boolean } => {
        if (!Array.isArray(value)) throw new OpError('points must be an array of [x, y] pairs');
        if (value.length < 2) throw new OpError('points needs at least 2 points');
        if (value.length > MAX_POINTS) throw new OpError(`points has more than ${MAX_POINTS} points`);
        let pressure = false;
        const points = value.map((p, i) => {
            if (!Array.isArray(p) || p.length < 2 || p.length > 3) throw new OpError(`points[${i}] must be [x, y] or [x, y, pressure]`);
            const at = toCanvas(box, num(p[0], `points[${i}][0]`), num(p[1], `points[${i}][1]`), notes);
            let z = 0.5;
            if (p.length === 3) {
                pressure = true;
                z = Math.min(1, Math.max(0, num(p[2], `points[${i}][2]`)));
            }
            return { x: at.x, y: at.y, z };
        });
        return { points, pressure };
    };

    /* ── One op each. Each validates EVERYTHING before its first mutation, so
       a refused op leaves nothing behind. ── */

    const createOp = (op: Json, index: number, createdByOp: Map<number, TLShapeId>, notes: Set<string>): TLShapeId => {
        const type = op.type;
        const color = oneOf<TLDefaultColorStyle>(op.color, COLORS, 'color');
        const sizeStyle = oneOf<TLDefaultSizeStyle>(op.size, SIZES, 'size');
        const dash = oneOf<TLDefaultDashStyle>(op.dash, DASHES, 'dash');
        const fill = oneOf<TLDefaultFillStyle>(op.fill, FILLS, 'fill');
        const pageIndex = paged() ? targetPage(op) : -1;
        const box = paged() ? pageBox(pageIndex) : null;
        const id = createShapeId();

        // Every style prop stated, never left to the pen: createShapes fills an
        // unstated style from `stylesForNextShape`, which is the USER's current
        // pen (a yellow highlighter, the pinned 's' size) — the agent's text
        // would come out in whatever the user last drew with.
        switch (type) {
            case 'text': {
                const at = toCanvas(box, num(op.x, 'x'), num(op.y, 'y'), notes);
                const content = text(op.text, 'text');
                const w = op.w === undefined ? undefined : size(op.w, 'w');
                const align = oneOf<'start' | 'middle' | 'end'>(op.align, ALIGNS, 'align') ?? 'start';
                editor.createShape({
                    id, type: 'text', x: at.x, y: at.y,
                    props: {
                        richText: toRichText(content),
                        color: color ?? 'black',
                        size: sizeStyle ?? 'm',
                        textAlign: align,
                        ...(w !== undefined ? { w, autoSize: false } : { autoSize: true }),
                    },
                });
                break;
            }
            case 'note': {
                const at = toCanvas(box, num(op.x, 'x'), num(op.y, 'y'), notes);
                editor.createShape({
                    id, type: 'note', x: at.x, y: at.y,
                    props: { richText: toRichText(text(op.text, 'text')), color: color ?? 'yellow', size: sizeStyle ?? 'm' },
                });
                break;
            }
            case 'geo': {
                const geo = oneOf<TLGeoShapeGeoStyle>(op.geo, GEOS, 'geo');
                if (!geo) throw new OpError('geo is required');
                const at = toCanvas(box, num(op.x, 'x'), num(op.y, 'y'), notes);
                const w = size(op.w, 'w');
                const h = size(op.h, 'h');
                const label = op.text === undefined ? undefined : text(op.text, 'text', true);
                const rotation = op.rotation === undefined ? 0 : radians(op.rotation, 'rotation');
                editor.createShape({
                    id, type: 'geo', x: at.x, y: at.y,
                    props: {
                        geo, w, h,
                        color: color ?? 'black',
                        fill: fill ?? 'none',
                        dash: dash ?? 'solid',
                        size: sizeStyle ?? 'm',
                        ...(label !== undefined ? { richText: toRichText(label) } : {}),
                    },
                });
                // About the centre: the agent gave the unrotated top-left, and
                // tldraw's own `rotation` turns about the origin corner.
                if (rotation) editor.rotateShapesBy([id], rotation);
                break;
            }
            case 'line': {
                const { points } = readPoints(op.points, box, notes);
                const origin = points[0];
                const indices = getIndices(points.length - 1);
                const linePoints: Record<string, TLLineShapePoint> = {};
                points.forEach((p, i) => {
                    linePoints[indices[i]] = { id: indices[i], index: indices[i], x: p.x - origin.x, y: p.y - origin.y };
                });
                editor.createShape({
                    id, type: 'line', x: origin.x, y: origin.y,
                    props: { points: linePoints, color: color ?? 'black', dash: dash ?? 'solid', size: sizeStyle ?? 'm', spline: 'line' },
                });
                break;
            }
            case 'draw': {
                const { points, pressure } = readPoints(op.points, box, notes);
                const closed = op.closed === undefined ? false : op.closed === true;
                if (op.closed !== undefined && typeof op.closed !== 'boolean') throw new OpError('closed must be a boolean');
                const dense: VecModel[] = [points[0]];
                for (let i = 1; i < points.length; i++) {
                    const a = points[i - 1];
                    const b = points[i];
                    const steps = Math.min(64, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / DRAW_STEP));
                    for (let s = 1; s < steps && dense.length < MAX_POINTS; s++) {
                        const t = s / steps;
                        dense.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, z: (a.z ?? 0.5) + ((b.z ?? 0.5) - (a.z ?? 0.5)) * t });
                    }
                    dense.push(b);
                }
                if (closed) dense.push({ ...dense[0] });
                let minX = Infinity;
                let minY = Infinity;
                for (const p of dense) { minX = Math.min(minX, p.x); minY = Math.min(minY, p.y); }
                const local = dense.map(p => ({ x: p.x - minX, y: p.y - minY, z: p.z ?? 0.5 }));
                const dim = pressure ? 3 : 2;
                editor.createShape({
                    id, type: 'draw', x: minX, y: minY,
                    props: {
                        segments: [dim === 2
                            ? { type: 'free', path: b64Vecs.encodePoints(local, 2), dim: 2 }
                            : { type: 'free', path: b64Vecs.encodePoints(local, 3) }],
                        isComplete: true,
                        isClosed: closed,
                        isPen: pressure,
                        color: color ?? 'black',
                        fill: 'none',
                        // 'solid' is what every canvas here pins (canvasPen.ts):
                        // the forked draw shape only takes over for it.
                        dash: 'solid',
                        size: sizeStyle ?? 's',
                    },
                });
                break;
            }
            case 'arrow': {
                // Resolve both ends before creating anything.
                const end = (value: unknown, name: string): { at: VecModel; target?: TLShape } => {
                    if (!isObject(value)) throw new OpError(`${name} must be {x, y} or {shapeId}`);
                    if (value.shapeId !== undefined) {
                        const target = resolveShape(value.shapeId, createdByOp, `${name}.shapeId`);
                        const b = editor.getShapePageBounds(target.id);
                        if (!b) throw new OpError(`${name}.shapeId has no position`);
                        return { at: { x: b.center.x, y: b.center.y }, target };
                    }
                    return { at: toCanvas(box, num(value.x, `${name}.x`), num(value.y, `${name}.y`), notes) };
                };
                const start = end(op.start, 'start');
                const finish = end(op.end, 'end');
                if (start.target && finish.target && start.target.id === finish.target.id) {
                    throw new OpError('start and end are bound to the same shape');
                }
                const bend = op.bend === undefined ? 0 : Math.max(-MAX_SIZE, Math.min(MAX_SIZE, num(op.bend, 'bend')));
                const label = op.text === undefined ? undefined : text(op.text, 'text', true);
                editor.createShape({
                    id, type: 'arrow', x: start.at.x, y: start.at.y,
                    props: {
                        start: { x: 0, y: 0 },
                        end: { x: finish.at.x - start.at.x, y: finish.at.y - start.at.y },
                        bend,
                        color: color ?? 'black',
                        dash: dash ?? 'solid',
                        size: sizeStyle ?? 'm',
                        fill: 'none',
                        ...(label !== undefined ? { richText: toRichText(label) } : {}),
                    },
                });
                // A connector: the binding is what makes the arrow follow the
                // shape when it moves. Props as tldraw's own arrow tool leaves
                // an ordinary (not precise) binding: to the centre, stopping at
                // the edge.
                for (const [terminal, info] of [['start', start], ['end', finish]] as const) {
                    if (!info.target) continue;
                    editor.createBinding({
                        type: 'arrow',
                        fromId: id,
                        toId: info.target.id,
                        props: { terminal, normalizedAnchor: { x: 0.5, y: 0.5 }, isExact: false, isPrecise: false, snap: 'none' },
                    });
                }
                break;
            }
            default:
                throw new OpError(`unknown shape type ${JSON.stringify(type)} (text, note, geo, line, arrow, draw)`);
        }

        // The pen's width is `props.scale`, stamped on every NEW shape that has
        // one by applyPenDefaults' create handler — the user's current pen
        // width, which would shrink the agent's text and boxes with it. Scale 1
        // leaves `size` meaning what the agent asked for. An update is not a
        // create, so the handler does not fire again.
        const made = editor.getShape(id);
        if (made && 'scale' in made.props && made.props.scale !== 1) {
            editor.updateShape({ id, type: made.type, props: { scale: 1 } } as TLShapePartial);
        }
        createdByOp.set(index + 1, id);
        return id;
    };

    const updateOp = (op: Json, createdByOp: Map<number, TLShapeId>, notes: Set<string>): TLShapeId => {
        const raw = String(op.id);
        const shape = resolveShape(op.id, createdByOp, 'id');
        assertUnlocked(shape, raw);
        const props = shape.props as Json;

        // Validate everything first.
        const color = oneOf<TLDefaultColorStyle>(op.color, COLORS, 'color');
        const sizeStyle = oneOf<TLDefaultSizeStyle>(op.size, SIZES, 'size');
        const dash = oneOf<TLDefaultDashStyle>(op.dash, DASHES, 'dash');
        const fill = oneOf<TLDefaultFillStyle>(op.fill, FILLS, 'fill');
        const label = op.text === undefined ? undefined : text(op.text, 'text', true);
        const x = optNum(op.x, 'x');
        const y = optNum(op.y, 'y');
        const w = op.w === undefined ? undefined : size(op.w, 'w');
        const h = op.h === undefined ? undefined : size(op.h, 'h');
        const rotation = op.rotation === undefined ? undefined : radians(op.rotation, 'rotation');
        const styles: Json = {};
        for (const [key, value] of [['color', color], ['size', sizeStyle], ['dash', dash], ['fill', fill]] as const) {
            if (value === undefined) continue;
            if (!(key in props)) throw new OpError(`a ${shape.type} shape has no ${key}`);
            styles[key] = value;
        }
        if (label !== undefined) {
            if (!('richText' in props)) throw new OpError(`a ${shape.type} shape has no text`);
            styles.richText = toRichText(label);
        }
        const bounds = editor.getShapePageBounds(shape.id);
        if (!bounds) throw new OpError(`${raw} has no position`);
        // x/y are relative to `page` when given, else to the page the shape is
        // on now — so "move it 20 right" is `x: summary.x + 20` either way, and
        // `page` alone carries the shape to the same spot on another page.
        const home = paged() ? pageBox(pageOfBounds(model.boxes(), bounds)) : null;
        const box = paged() ? (op.page === undefined ? home : pageBox(targetPage(op))) : null;

        if (Object.keys(styles).length > 0) {
            editor.updateShape({ id: shape.id, type: shape.type, props: styles } as TLShapePartial);
        }
        const now = editor.getShapePageBounds(shape.id) ?? bounds;
        // Geometry only when asked for: a restyle must not "clamp" a stroke the
        // user drew hanging off the page's edge.
        const moves = x !== undefined || y !== undefined || op.page !== undefined || w !== undefined || h !== undefined;
        if (moves) {
            const target = toCanvas(box, x ?? now.x - (home?.x ?? 0), y ?? now.y - (home?.y ?? 0), notes);
            if (w !== undefined || h !== undefined) {
                editor.resizeToBounds([shape.id], { x: target.x, y: target.y, w: w ?? now.w, h: h ?? now.h });
            } else if (target.x !== now.x || target.y !== now.y) {
                editor.nudgeShapes([shape.id], { x: target.x - now.x, y: target.y - now.y });
            }
        }
        if (rotation !== undefined) {
            const current = editor.getShapePageTransform(shape.id).rotation();
            const delta = rotation - current;
            if (Math.abs(delta) > 1e-6) editor.rotateShapesBy([shape.id], delta);
        }
        return shape.id;
    };

    const deleteOp = (op: Json, createdByOp: Map<number, TLShapeId>, errors: string[], index: number): TLShapeId[] => {
        if (!Array.isArray(op.ids) || op.ids.length === 0) throw new OpError('ids must be a non-empty array of shape ids');
        const ids: TLShapeId[] = [];
        for (const raw of op.ids) {
            try {
                const shape = resolveShape(raw, createdByOp, 'id');
                assertUnlocked(shape, String(raw));
                ids.push(shape.id);
            } catch (err) {
                if (!(err instanceof OpError)) throw err;
                errors.push(`op ${index + 1}: ${err.message}`);
            }
        }
        if (ids.length) editor.deleteShapes(ids);
        return ids;
    };

    return {
        shapes(page?: number): ShapeSummary[] {
            const boxes = model.boxes();
            const want = page !== undefined && boxes.length > 0 ? page - 1 : null;
            const out: ShapeSummary[] = [];
            for (const shape of agentShapes(editor, model)) {
                if (want !== null) {
                    const b = editor.getShapePageBounds(shape.id);
                    if (!b || pageOfBounds(boxes, b) !== want) continue;
                }
                const summary = summarizeShape(editor, model, shape);
                if (summary) out.push(summary);
            }
            return out;
        },

        currentPage(): number {
            return model.currentPage() + 1;
        },

        apply(ops): CanvasApplyResult {
            const result: CanvasApplyResult = { created: [], updated: [], deleted: [], errors: [] };
            const list: unknown = ops;
            if (!Array.isArray(list) || list.length === 0) {
                result.errors.push('ops must be a non-empty array');
                return result;
            }
            if (list.length > MAX_OPS) {
                result.errors.push(`at most ${MAX_OPS} ops per call (got ${list.length}); nothing was applied`);
                return result;
            }
            const createdByOp = new Map<number, TLShapeId>();
            const mark = editor.markHistoryStoppingPoint('agent canvas edit');
            try {
                editor.run(() => {
                    list.forEach((op: unknown, index) => {
                        const notes = new Set<string>();
                        try {
                            if (!isObject(op)) throw new OpError('must be an object');
                            if (op.op === 'create') result.created.push(createOp(op, index, createdByOp, notes));
                            else if (op.op === 'update') result.updated.push(updateOp(op, createdByOp, notes));
                            else if (op.op === 'delete') result.deleted.push(...deleteOp(op, createdByOp, result.errors, index));
                            else throw new OpError(`unknown op ${JSON.stringify(op.op)} (create, update, delete)`);
                            for (const note of notes) result.errors.push(`op ${index + 1}: note: ${note}`);
                        } catch (err) {
                            if (!(err instanceof OpError)) throw err;
                            result.errors.push(`op ${index + 1}: ${err.message}`);
                        }
                    });
                });
            } catch (err) {
                // Something tldraw itself refused mid-batch (a validation error
                // on a record): the batch may be half in, so take ALL of it back
                // rather than leave the user with a fragment of it to undo.
                // (tldraw's transaction has usually rolled the records back
                // already; the bail is for anything it did not.)
                try { editor.bailToMark(mark); } catch { /* nothing left to take back */ }
                const message = err instanceof Error ? err.message : String(err);
                return {
                    created: [], updated: [], deleted: [],
                    errors: [...result.errors, `nothing was applied: the canvas refused the change (${message})`],
                };
            }
            return result;
        },
    };
}
