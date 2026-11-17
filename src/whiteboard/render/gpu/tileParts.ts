// The prepared paint, flattened into the parts each one paints and indexed by world rectangle. A tile asks for the parts
// that reach its span; a new revision re-derives only the items its changed regions touch, and reports only what it
// actually changed. Indexing is resumable: one item per step, stepped under the frame's budget.
//
// What is reported to takeChanges, and why (the counters say which cause fired):
//   • index:regions (+rects)   the scene's changed regions, when the revision moved;
//   • index:members            items that entered or left the prepared paint (its item set changed, not its content);
//   • index:epoch              text items whose font epoch moved;
//   • index:rederive           items re-derived because a changed region reaches them;
//   • index:rebuild-all        the index was rebuilt from nothing (unknown revision span, or theme/raster variant changed).
// A new paint object with the same revision and the same items reports nothing: its items are reused by identity.
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
/** A part's order is its item's sequence times this span, plus its index among the item's parts: an item never has
 * 2^20 parts (a text item has one per glyph run, never that many). */
const ORDER_SPAN = 1048576;
/** Above this many parts a query sorts with the native sort; below it an insertion sort allocates nothing. */
const INSERTION_SORT_MAX = 64;
const NO_RECTS: readonly Rect[] = Object.freeze([]);

type Root = PreparedPaint2d['root'];
type Windows = PreparedPaint2d['windows'];

/** A part as the index keeps it: the contract's TilePart, with the order the index assigns and a query mark. */
interface IndexedPart extends TilePart { order: number; mark: number }
/** One item of the prepared paint and the parts it contributes. Entries are the unit of reuse across revisions. */
interface Entry {
    item: PaintItem;
    readonly band: PaintBand;
    readonly nodeId: string;
    readonly key: string;
    readonly blend: Blend;
    /** A text item's font epoch; −1 for every other kind. */
    readonly epoch: number;
    readonly parts: IndexedPart[];
    /** The union of the parts' world rects, or null when the item paints nothing. */
    readonly bounds: Rect | null;
    /** The item's position in canonical order, and the position its parts were last numbered for. */
    seq: number;
    placed: number;
    /** The pass that last matched this entry; an entry no pass matched has left the paint. */
    stamp: number;
}
interface Cell { readonly cx: number; readonly cy: number; readonly parts: IndexedPart[]; slot: number }
interface Grid {
    /** cx → cy → the cell's parts. */
    readonly cells: Map<number, Map<number, Cell>>;
    /** Every populated cell, so a query that names more cells than are populated walks these instead. */
    readonly populated: Cell[];
    readonly wide: IndexedPart[];
    count: number;
}
/** The published index. Mutated in place by an incremental build's apply; a full rebuild publishes a new one. */
interface Index {
    version: number;
    revision: number;
    theme: Root['theme'];
    variant: Root['rasterVariant'];
    windows: Windows;
    entries: Entry[];
    /** Node id → its entries, so a new item finds the old entry it may reuse, and boundsOfNodes finds a node's parts. */
    readonly byNode: Map<string, Entry[]>;
    readonly grid: Grid;
}
/** One index being built: the cursor through the windows, the entries it has kept or derived, and what it will report. */
interface Build {
    readonly revision: number;
    readonly theme: Root['theme'];
    readonly variant: Root['rasterVariant'];
    readonly windows: Windows;
    /** The index it is built from, which an incremental apply mutates; null for a full rebuild. */
    readonly old: Index | null;
    /** The index it becomes: the old one (incremental) or a new one (full). */
    readonly target: Index;
    readonly full: boolean;
    readonly regions: readonly Rect[];
    readonly regionBox: Rect | null;
    readonly pass: number;
    readonly next: Entry[];
    readonly added: Entry[];
    window: number;
    item: number;
    seq: number;
    replaced: number;
    epochs: number;
    rederived: number;
}

function newGrid(): Grid {
    return { cells: new Map(), populated: [], wide: [], count: 0 };
}
/** A paint item's blend as a tile sees it: a multiply item is laid by `modulate`, everything else by `over`. */
function blendOf(item: PaintItem): Blend {
    return (item.kind === 'image' ? item.blend : item.material.blend) === 'multiply' ? 'modulate' : 'over';
}
function unionOf(a: Rect | null, b: Readonly<Rect>): Rect {
    if (!a) return { x: b.x, y: b.y, width: b.width, height: b.height };
    const x0 = Math.min(a.x, b.x), y0 = Math.min(a.y, b.y);
    const x1 = Math.max(a.x + a.width, b.x + b.width), y1 = Math.max(a.y + a.height, b.y + b.height);
    return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}
function reachesWorld(rect: Readonly<Rect>, world: Readonly<Rect>): boolean {
    return rect.x <= world.x + world.width && rect.x + rect.width >= world.x
        && rect.y <= world.y + world.height && rect.y + rect.height >= world.y;
}
/** The cells a world rect reaches: first and last column, first and last row. */
function cellSpan(r: Readonly<Rect>): readonly [number, number, number, number] {
    return [Math.floor(r.x / CELL), Math.floor((r.x + r.width) / CELL), Math.floor(r.y / CELL), Math.floor((r.y + r.height) / CELL)];
}
function removeFrom<T>(list: T[], value: T): void {
    const at = list.indexOf(value);
    if (at < 0) return;
    list[at] = list[list.length - 1];
    list.pop();
}

function insertPart(grid: Grid, part: IndexedPart): void {
    grid.count++;
    const [x0, x1, y0, y1] = cellSpan(part.world);
    if ((x1 - x0 + 1) * (y1 - y0 + 1) > MAX_CELLS) { grid.wide.push(part); return; }
    for (let cx = x0; cx <= x1; cx++) {
        let column = grid.cells.get(cx);
        if (!column) { column = new Map(); grid.cells.set(cx, column); }
        for (let cy = y0; cy <= y1; cy++) {
            let cell = column.get(cy);
            if (!cell) {
                cell = { cx, cy, parts: [], slot: grid.populated.length };
                grid.populated.push(cell);
                column.set(cy, cell);
            }
            cell.parts.push(part);
        }
    }
}
function removePart(grid: Grid, part: IndexedPart): void {
    grid.count--;
    const [x0, x1, y0, y1] = cellSpan(part.world);
    if ((x1 - x0 + 1) * (y1 - y0 + 1) > MAX_CELLS) { removeFrom(grid.wide, part); return; }
    for (let cx = x0; cx <= x1; cx++) {
        const column = grid.cells.get(cx);
        if (!column) continue;
        for (let cy = y0; cy <= y1; cy++) {
            const cell = column.get(cy);
            if (!cell) continue;
            removeFrom(cell.parts, part);
            if (cell.parts.length) continue;
            column.delete(cy);
            // Swap-remove from the populated list, so the list stays dense and no iterator is needed to walk it.
            const last = grid.populated.pop();
            if (last && last !== cell) { grid.populated[cell.slot] = last; last.slot = cell.slot; }
        }
        if (!column.size) grid.cells.delete(cx);
    }
}

/** Numbers an entry's parts for its canonical position. */
function place(entry: Entry): void {
    if (entry.parts.length >= ORDER_SPAN) throw new RangeError('Paint item has too many parts to order');
    const base = entry.seq * ORDER_SPAN;
    for (let i = 0; i < entry.parts.length; i++) entry.parts[i].order = base + i;
    entry.placed = entry.seq;
}
function byOrder(a: IndexedPart, b: IndexedPart): number { return a.order - b.order; }
/** Orders a query's parts in place: an insertion sort for the usual handful, the native sort beyond that. */
function sortByOrder(out: IndexedPart[]): void {
    if (out.length > INSERTION_SORT_MAX) { out.sort(byOrder); return; }
    for (let i = 1; i < out.length; i++) {
        const part = out[i];
        let j = i - 1;
        while (j >= 0 && out[j].order > part.order) { out[j + 1] = out[j]; j--; }
        out[j + 1] = part;
    }
}
/** Appends `part` to a query's output once, if it is on the band, reaches the world and is not omitted. */
function consider(out: IndexedPart[], part: IndexedPart, band: PaintBand, world: Readonly<Rect>, omit: ReadonlySet<string> | undefined, stamp: number): void {
    if (part.band !== band || part.mark === stamp || omit?.has(part.nodeId) || !reachesWorld(part.world, world)) return;
    part.mark = stamp;
    out.push(part);
}

/**
 * Whether a set of node ids differs from the last one an omit tracker saw. A drag hands over a new Set every frame, so
 * identity is no test; the members are. Allocates only when the members change.
 */
export class OmitTracker {
    readonly #last = new Set<string>();
    /** True when `omit` names other nodes than the last call did; a new Set of the same nodes is not a change. */
    changed(omit: ReadonlySet<string> | undefined): boolean {
        const size = omit?.size ?? 0;
        let same = size === this.#last.size;
        if (same && omit) for (const id of omit) if (!this.#last.has(id)) { same = false; break; }
        if (same) return false;
        this.#last.clear();
        if (omit) for (const id of omit) this.#last.add(id);
        return true;
    }
}

export const createTileParts: CreateTileParts = (_host, audit) => {
    /** The published index; null until the first build publishes. */
    let index: Index | null = null;
    /** The build in progress, if any. Only one runs at a time; a newer paint waits for it to publish. */
    let building: Build | null = null;
    /** The entries array the last apply replaced, kept to be the next build's buffer. */
    let spare: Entry[] = [];
    let passes = 0;
    /** Changes accumulated since the last takeChanges. */
    let pending: Rect[] = [];
    let pendingAll = false;
    let changesReady = false;
    let queryStamp = 0;
    /** The output of partsFor, reused: the caller copies it to keep it. */
    const out: IndexedPart[] = [];
    /** boundsOfNodes' cache: valid for one index version and one set of ids. */
    let boundsVersion = -1;
    let boundsIds = new Set<string>();
    let boundsRects: Rect[] = [];

    const reachesAnyRegion = (entry: Entry, build: Build): boolean => {
        if (!entry.bounds || !build.regionBox || !reachesWorld(entry.bounds, build.regionBox)) return false;
        for (const region of build.regions) if (reachesWorld(entry.bounds, region)) return true;
        return false;
    };

    /** Derives an item's parts: the contributions of its paint, with their world bounds. Build-time only. */
    const derive = (band: PaintBand, item: PaintItem, blend: Blend): Entry => {
        const parts: IndexedPart[] = [];
        let bounds: Rect | null = null;
        for (const contribution of paintContributions(item)) {
            const job = new PaintBoundsJob(contribution);
            while (!job.step(256));
            const world = job.result;
            if (!world) continue;
            parts.push({ band, order: 0, nodeId: item.nodeId, item: contribution, world, blend, mark: 0 });
            bounds = unionOf(bounds, world);
        }
        return { item, band, nodeId: item.nodeId, key: item.key, blend, epoch: item.kind === 'text' ? item.paint.fontEpoch : -1,
            parts, bounds, seq: 0, placed: -1, stamp: 0 };
    };

    /** Handles one item of the build's walk: reuses its old entry when nothing a region or a font epoch changed reaches it,
     * otherwise derives it. Reuse by identity or by unchanged bounds costs nothing and reports nothing. */
    const visit = (build: Build, band: PaintBand, item: PaintItem): void => {
        const blend = blendOf(item), seq = build.seq++;
        const epoch = item.kind === 'text' ? item.paint.fontEpoch : -1;
        let candidate: Entry | undefined;
        if (build.old) {
            const list = build.old.byNode.get(item.nodeId);
            if (list) for (const entry of list) if (entry.stamp !== build.pass && entry.key === item.key) { candidate = entry; break; }
        }
        if (candidate) {
            const sameEpoch = candidate.epoch === epoch;
            if (sameEpoch && candidate.band === band && candidate.blend === blend) {
                if (candidate.item === item || !reachesAnyRegion(candidate, build)) {
                    candidate.item = item; candidate.seq = seq; candidate.stamp = build.pass;
                    build.next.push(candidate);
                    return;
                }
                build.rederived++;
            } else if (!sameEpoch) build.epochs++;
            else build.rederived++;
            build.replaced++;
        }
        const entry = derive(band, item, blend);
        entry.seq = seq;
        build.next.push(entry);
        build.added.push(entry);
    };

    const startBuild = (prepared: PreparedPaint2d): Build => {
        const root = prepared.root, revision = root.sceneRevision;
        let full = !index || index.theme !== root.theme || index.variant !== root.rasterVariant;
        let regions: readonly Rect[] = NO_RECTS;
        if (!full && index) {
            const changes = root.regionChangesSince?.(index.revision);
            if (!changes || changes.full) full = true;
            else regions = changes.regions;
        }
        let regionBox: Rect | null = null;
        for (const region of regions) regionBox = unionOf(regionBox, region);
        const target: Index = full || !index
            ? { version: 0, revision, theme: root.theme, variant: root.rasterVariant, windows: prepared.windows,
                entries: [], byNode: new Map(), grid: newGrid() }
            : index;
        const next = spare;
        next.length = 0;
        spare = [];
        return { revision, theme: root.theme, variant: root.rasterVariant, windows: prepared.windows,
            old: full ? null : index, target, full, regions, regionBox, pass: ++passes, next, added: [],
            window: 0, item: 0, seq: 0, replaced: 0, epochs: 0, rederived: 0 };
    };

    /** One item of the walk; true once every window has been visited. */
    const step = (build: Build): boolean => {
        const windows = build.windows;
        while (build.window < windows.length && build.item >= windows[build.window].items.length) { build.window++; build.item = 0; }
        if (build.window >= windows.length) return true;
        const window = windows[build.window];
        visit(build, window.band, window.items[build.item++]);
        return false;
    };

    const publish = (build: Build): void => {
        const target = build.target, old = build.old;
        if (build.full) {
            // A full rebuild has no old entries to take out: its target is new, and the old index is dropped.
            pendingAll = true;
            pending = [];
        } else {
            const regions = build.regions;
            if (regions.length) {
                auditCount(audit, 'index:regions', regions.length);
                if (!pendingAll) for (const region of regions) pending.push(region);
            }
        }
        let removed = 0;
        if (old) {
            for (const entry of old.entries) {
                if (entry.stamp === build.pass) continue;
                removed++;
                for (const part of entry.parts) {
                    removePart(target.grid, part);
                    if (!pendingAll) pending.push(part.world);
                }
                const list = target.byNode.get(entry.nodeId);
                if (list) {
                    removeFrom(list, entry);
                    if (!list.length) target.byNode.delete(entry.nodeId);
                }
            }
        }
        for (const entry of build.added) {
            for (const part of entry.parts) {
                insertPart(target.grid, part);
                if (!pendingAll && !build.full) pending.push(part.world);
            }
            const list = target.byNode.get(entry.nodeId);
            if (list) list.push(entry); else target.byNode.set(entry.nodeId, [entry]);
        }
        for (const entry of build.next) if (entry.placed !== entry.seq) place(entry);
        if (build.full) {
            auditCount(audit, 'index:rebuild-all');
            auditCount(audit, 'parts:indexed', target.grid.count);
        } else {
            // Entries that entered or left the paint, not counting the replaced ones: those are counted by their cause.
            const members = build.added.length + removed - 2 * build.replaced;
            if (members) auditCount(audit, 'index:members', members);
            if (build.epochs) auditCount(audit, 'index:epoch', build.epochs);
            if (build.rederived) auditCount(audit, 'index:rederive', build.rederived);
        }
        spare = target.entries;
        spare.length = 0;
        target.entries = build.next;
        target.version = (index?.version ?? 0) + 1;
        target.revision = build.revision;
        target.theme = build.theme;
        target.variant = build.variant;
        target.windows = build.windows;
        index = target;
        changesReady = true;
    };

    return {
        sync(prepared: PreparedPaint2d, budget: FrameBudget): boolean {
            const root = prepared.root;
            if (!building && index && index.windows === prepared.windows && index.revision === root.sceneRevision
                && index.theme === root.theme && index.variant === root.rasterVariant) return true;
            // An index in progress is finished first, as the paint it was started from; the next call indexes the newer one.
            if (!building) building = startBuild(prepared);
            const build = building;
            // At least one item per call: an exhausted budget still moves the index forward.
            let done = false;
            do { done = step(build); } while (!done && !budget.shouldYield());
            if (!done) return false;
            publish(build);
            building = null;
            return true;
        },
        partsFor(band: PaintBand, world: Readonly<Rect>, omit?: ReadonlySet<string>): readonly TilePart[] {
            out.length = 0;
            if (!index) return out;
            const grid = index.grid, stamp = ++queryStamp;
            // The cell span, inline: a tuple here would be an allocation on every query.
            const x0 = Math.floor(world.x / CELL), x1 = Math.floor((world.x + world.width) / CELL);
            const y0 = Math.floor(world.y / CELL), y1 = Math.floor((world.y + world.height) / CELL);
            // A query that names more cells than are populated walks the populated cells instead.
            if ((x1 - x0 + 1) * (y1 - y0 + 1) > grid.populated.length) {
                for (const cell of grid.populated) {
                    if (cell.cx < x0 || cell.cx > x1 || cell.cy < y0 || cell.cy > y1) continue;
                    for (let i = 0; i < cell.parts.length; i++) consider(out, cell.parts[i], band, world, omit, stamp);
                }
            } else {
                for (let cx = x0; cx <= x1; cx++) {
                    const column = grid.cells.get(cx);
                    if (!column) continue;
                    for (let cy = y0; cy <= y1; cy++) {
                        const cell = column.get(cy);
                        if (!cell) continue;
                        for (let i = 0; i < cell.parts.length; i++) consider(out, cell.parts[i], band, world, omit, stamp);
                    }
                }
            }
            for (let i = 0; i < grid.wide.length; i++) consider(out, grid.wide[i], band, world, omit, stamp);
            sortByOrder(out);
            return out;
        },
        takeChanges(): readonly Rect[] | 'all' {
            if (!changesReady) return NO_RECTS;
            changesReady = false;
            if (pendingAll) { pendingAll = false; pending = []; return 'all'; }
            if (!pending.length) return NO_RECTS;
            const taken = pending;
            pending = [];
            return taken;
        },
        boundsOfNodes(ids: ReadonlySet<string>): readonly Rect[] {
            if (!index || !ids.size) return NO_RECTS;
            if (boundsVersion === index.version) {
                let same = ids.size === boundsIds.size;
                if (same) for (const id of ids) if (!boundsIds.has(id)) { same = false; break; }
                if (same) return boundsRects;
            }
            const rects: Rect[] = [];
            for (const id of ids) {
                const entries = index.byNode.get(id);
                if (entries) for (const entry of entries) for (const part of entry.parts) rects.push(part.world);
            }
            boundsVersion = index.version;
            boundsIds = new Set(ids);
            boundsRects = rects;
            return rects;
        },
    } satisfies TileParts;
};
