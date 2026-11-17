// The prepared paint, flattened into the parts each one paints and indexed by world rectangle. A tile asks for the
// parts that reach its span; a revision asks only for the rects that changed. Indexing is a resumable generator
// stepped under the frame's budget, because a large board's windows are too much for one frame's allowance.
import type { Rect } from '../../../platform/types';
import type { FrameBudget } from '../../../platform/render/types';
import { auditCount } from '../../../platform/render/renderAudit';
import type { PaintBand } from '../material';
import { PaintBoundsJob } from '../paintBounds';
import { paintContributions } from '../paintContributions';
import type { PaintItem } from '../paintStream';
import type { PreparedPaint2d } from '../reference/canvasPaintAdapter';
import type { Blend, CreateTileParts, TilePart, TileParts } from './contracts';

/** World edge of one index cell. A part is listed in every cell it reaches; one that reaches more than MAX_CELLS cells (a
 * page, a whole frame) waits in a short list every query reads, so a query never walks it cell by cell. */
const CELL = 1024, MAX_CELLS = 16;
const NO_RECTS: readonly Rect[] = Object.freeze([]);

interface Grid {
    /** cx → cy → the parts whose bounds reach that cell. */
    readonly cells: Map<number, Map<number, TilePart[]>>;
    cellCount: number;
    readonly wide: TilePart[];
    /** Node id → the world rect of each of its parts, for omission and drag. */
    readonly byNode: Map<string, Rect[]>;
    /** Text items by node and key → their font epoch and the rects of their parts: a font change moves text without a revision. */
    readonly texts: Map<string, { epoch: number; rects: Rect[] }>;
    count: number;
}
/** One index being built: the revision and stamp it describes, and the steps that fill its grid. */
interface Build {
    readonly revision: number;
    readonly stamp: string;
    readonly grid: Grid;
    readonly steps: Generator<void, void, undefined>;
    readonly prepared: PreparedPaint2d;
    done: boolean;
}

function newGrid(): Grid {
    return { cells: new Map(), cellCount: 0, wide: [], byNode: new Map(), texts: new Map(), count: 0 };
}
/** Theme and raster variant: a frame of another stamp is a different picture at the same revision. */
function stampOf(prepared: PreparedPaint2d): string {
    return `${prepared.root.theme ?? ''}|${prepared.root.rasterVariant ?? ''}`;
}
/** A paint item's blend as a tile sees it: a multiply item is laid by `modulate`, everything else by `over`. */
function blendOf(item: PaintItem): Blend {
    return (item.kind === 'image' ? item.blend : item.material.blend) === 'multiply' ? 'modulate' : 'over';
}
/** The text key of an item: its node and its key, stable across the paint objects of one scene revision. */
function textKey(item: PaintItem): string {
    return `${item.nodeId}|${item.key}`;
}
/** Whether a paint's text items differ from the ones an index was built from: a new font epoch on any of them, or a
 * different set. A font change is not a scene change, so this is the only way the index learns of it. */
function textsChanged(grid: Grid, prepared: PreparedPaint2d): boolean {
    let seen = 0;
    for (const window of prepared.windows) {
        for (const item of window.items) {
            if (item.kind !== 'text') continue;
            seen++;
            const entry = grid.texts.get(textKey(item));
            if (!entry || entry.epoch !== item.paint.fontEpoch) return true;
        }
    }
    return seen !== grid.texts.size;
}
/** Rects whose text changed in font epoch (or appeared, or vanished) between two indexes: both the old and the new extent. */
function changedTextRects(oldGrid: Grid | null, newGrid: Grid): Rect[] {
    const out: Rect[] = [];
    for (const [key, entry] of newGrid.texts) {
        const old = oldGrid?.texts.get(key);
        if (old && old.epoch === entry.epoch) continue;
        for (const rect of entry.rects) out.push(rect);
        if (old) for (const rect of old.rects) out.push(rect);
    }
    if (oldGrid) {
        for (const [key, old] of oldGrid.texts) {
            if (newGrid.texts.has(key)) continue;
            for (const rect of old.rects) out.push(rect);
        }
    }
    return out;
}

function reachesWorld(rect: Rect, world: Readonly<Rect>): boolean {
    return rect.x <= world.x + world.width && rect.x + rect.width >= world.x
        && rect.y <= world.y + world.height && rect.y + rect.height >= world.y;
}

function insert(grid: Grid, part: TilePart): void {
    grid.count++;
    const rects = grid.byNode.get(part.nodeId);
    if (rects) rects.push(part.world); else grid.byNode.set(part.nodeId, [part.world]);
    const r = part.world;
    const x0 = Math.floor(r.x / CELL), x1 = Math.floor((r.x + r.width) / CELL);
    const y0 = Math.floor(r.y / CELL), y1 = Math.floor((r.y + r.height) / CELL);
    if ((x1 - x0 + 1) * (y1 - y0 + 1) > MAX_CELLS) { grid.wide.push(part); return; }
    for (let cx = x0; cx <= x1; cx++) {
        let column = grid.cells.get(cx);
        if (!column) { column = new Map(); grid.cells.set(cx, column); }
        for (let cy = y0; cy <= y1; cy++) {
            let list = column.get(cy);
            if (!list) { list = []; column.set(cy, list); grid.cellCount++; }
            list.push(part);
        }
    }
}

/** The indexing steps: one checkpoint after every part, so a budget yield lands between two parts, never inside one. */
function* indexSteps(prepared: PreparedPaint2d, grid: Grid): Generator<void, void, undefined> {
    const order = { n: 0 };
    for (const window of prepared.windows) {
        for (const original of window.items) {
            const blend = blendOf(original);
            let text: { epoch: number; rects: Rect[] } | undefined;
            if (original.kind === 'text') {
                text = { epoch: original.paint.fontEpoch, rects: [] };
                grid.texts.set(textKey(original), text);
            }
            for (const part of paintContributions(original)) {
                const job = new PaintBoundsJob(part);
                while (!job.step(256)) yield;
                const world = job.result;
                if (world) {
                    insert(grid, { band: window.band, order: order.n++, nodeId: original.nodeId, item: part, world, blend });
                    text?.rects.push(world);
                }
                yield;
            }
        }
    }
}

export const createTileParts: CreateTileParts = (_host, audit) => {
    // The published index: what partsFor answers from. `building` is the next one, until its steps run out.
    let indexed: { readonly revision: number; readonly stamp: string; readonly grid: Grid; prepared: PreparedPaint2d } | null = null;
    let building: Build | null = null;
    // Changes from the published index to the one being built. Reported once, when that build is published.
    let pending: readonly Rect[] | 'all' = NO_RECTS;
    let completed = false;

    const changesSince = (prepared: PreparedPaint2d, stamp: string): readonly Rect[] | 'all' => {
        if (!indexed || indexed.stamp !== stamp) return 'all';
        const changes = prepared.root.regionChangesSince?.(indexed.revision);
        return !changes || changes.full ? 'all' : changes.regions;
    };

    return {
        sync(prepared: PreparedPaint2d, budget: FrameBudget): boolean {
            const stamp = stampOf(prepared), revision = prepared.root.sceneRevision;
            if (!building && indexed && indexed.stamp === stamp && indexed.revision === revision) {
                if (indexed.prepared === prepared) return true;
                // A new paint object of the same revision changes the index only through a text epoch.
                if (!textsChanged(indexed.grid, prepared)) { indexed.prepared = prepared; return true; }
            }
            // An index in progress is finished even if the paint object moved on: its geometry is the same revision's, and a
            // font change it missed is caught by the next sync, which compares the epochs it published.
            if (!building || building.revision !== revision || building.stamp !== stamp) {
                pending = changesSince(prepared, stamp);
                // The zoom question: how often a paint change rebuilds the index, and whether it reports everything.
                auditCount(audit, pending === 'all' ? 'index:rebuild-all' : 'index:rebuild-regions');
                const grid = newGrid();
                building = { revision, stamp, grid, steps: indexSteps(prepared, grid), prepared, done: false };
            }
            const build = building;
            // At least one checkpoint per call: an exhausted budget still moves the index forward.
            do {
                if (build.steps.next().done) { build.done = true; break; }
            } while (!budget.shouldYield());
            if (!build.done) return false;
            // Font changes count as changes: the rects of text whose epoch moved, before and after, join the reported set.
            if (pending !== 'all') pending = pending.concat(changedTextRects(indexed?.grid ?? null, build.grid));
            indexed = { revision: build.revision, stamp: build.stamp, grid: build.grid, prepared: build.prepared };
            building = null;
            completed = true;
            auditCount(audit, 'parts:indexed', build.grid.count);
            return true;
        },
        partsFor(band: PaintBand, world: Readonly<Rect>, omit?: ReadonlySet<string>): readonly TilePart[] {
            if (!indexed) return [];
            const grid = indexed.grid, out: TilePart[] = [], seen = new Set<TilePart>();
            const take = (part: TilePart): void => {
                if (part.band !== band || seen.has(part) || omit?.has(part.nodeId) || !reachesWorld(part.world, world)) return;
                seen.add(part); out.push(part);
            };
            const x0 = Math.floor(world.x / CELL), x1 = Math.floor((world.x + world.width) / CELL);
            const y0 = Math.floor(world.y / CELL), y1 = Math.floor((world.y + world.height) / CELL);
            // A query that names more cells than are populated walks the populated cells instead.
            if ((x1 - x0 + 1) * (y1 - y0 + 1) > grid.cellCount) {
                for (const [cx, column] of grid.cells) {
                    if (cx < x0 || cx > x1) continue;
                    for (const [cy, list] of column) if (cy >= y0 && cy <= y1) for (const part of list) take(part);
                }
            } else {
                for (let cx = x0; cx <= x1; cx++) {
                    const column = grid.cells.get(cx);
                    if (!column) continue;
                    for (let cy = y0; cy <= y1; cy++) for (const part of column.get(cy) ?? []) take(part);
                }
            }
            for (const part of grid.wide) take(part);
            return out.sort((a, b) => a.order - b.order);
        },
        takeChanges(): readonly Rect[] | 'all' {
            if (!completed) return NO_RECTS;
            completed = false;
            const out = pending;
            pending = NO_RECTS;
            return out;
        },
        boundsOfNodes(ids: ReadonlySet<string>): readonly Rect[] {
            if (!indexed || !ids.size) return NO_RECTS;
            const out: Rect[] = [];
            for (const id of ids) for (const rect of indexed.grid.byNode.get(id) ?? []) out.push(rect);
            return out;
        },
    };
};
