import type { Rect } from '../../../platform/types';
import type { FrameBudget } from '../../../platform/render/types';
import { auditCount } from '../../../platform/render/renderAudit';
import type { PaintBand } from '../material';
import { PaintBoundsJob } from '../paintBounds';
import { paintContributions } from '../paintContributions';
import type { PaintItem, PaintSource } from '../paintStream';
import { originalOf } from '../../media/videoFrames';
import type { PreparedPaint2d } from '../reference/canvasPaintAdapter';
import type { Blend, CreateTileParts, TilePart, TileParts } from './contracts';

const CELL = 1024, MAX_CELLS = 16;
const ORDER_SPAN = 1048576;
const INSERTION_SORT_MAX = 64;
const NO_RECTS: readonly Rect[] = Object.freeze([]);

type Root = PreparedPaint2d['root'];
type Windows = PreparedPaint2d['windows'];

interface IndexedPart extends TilePart { order: number; mark: number }
interface Entry {
    item: PaintItem;
    readonly band: PaintBand;
    readonly nodeId: string;
    readonly key: string;
    readonly blend: Blend;
    readonly epoch: number;
    readonly parts: IndexedPart[];
    readonly bounds: Rect | null;
    seq: number;
    placed: number;
    stamp: number;
}
interface Cell { readonly cx: number; readonly cy: number; readonly parts: IndexedPart[]; slot: number }
interface Grid {
    readonly cells: Map<number, Map<number, Cell>>;
    readonly populated: Cell[];
    readonly wide: IndexedPart[];
    count: number;
}
interface Index {
    version: number;
    revision: number;
    original: PaintSource | null;
    theme: Root['theme'];
    variant: Root['rasterVariant'];
    windows: Windows;
    entries: Entry[];
    readonly byNode: Map<string, Entry[]>;
    readonly grid: Grid;
}
interface Derivation {
    readonly band: PaintBand;
    readonly item: PaintItem;
    readonly blend: Blend;
    readonly seq: number;
    readonly contributions: readonly PaintItem[];
    index: number;
    job: PaintBoundsJob | null;
    readonly parts: IndexedPart[];
    bounds: Rect | null;
}
interface Build {
    readonly original: PaintSource;
    readonly revision: number;
    readonly theme: Root['theme'];
    readonly variant: Root['rasterVariant'];
    readonly windows: Windows;
    readonly old: Index | null;
    readonly target: Index;
    readonly full: boolean;
    readonly cause: 'no-index' | 'theme' | 'variant' | null;
    deriving: Derivation | null;
    readonly prior: boolean;
    readonly unknown: boolean;
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
function sameNumbers(a: readonly number[], b: readonly number[]): boolean {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
}
function contentTail(item: PaintItem): unknown {
    if (item.kind === 'image') return [item.imageKey, item.rect, item.sourceRect ?? null, item.opacity, item.inverted, item.blend,
        item.retainedTile ?? false, item.allocationBounds ?? null];
    return [item.material, item.allocationBounds ?? null];
}
export function sameItemContent(a: PaintItem, b: PaintItem): boolean {
    if (a.kind !== b.kind || a.nodeId !== b.nodeId || a.key !== b.key || a.geometryKey !== b.geometryKey) return false;
    if (!sameNumbers(a.localToWorld, b.localToWorld) || a.clips.length !== b.clips.length) return false;
    for (let i = 0; i < a.clips.length; i++) {
        const x = a.clips[i], y = b.clips[i];
        if (x.key !== y.key || x.fillRule !== y.fillRule || !sameNumbers(x.localToWorld, y.localToWorld) || JSON.stringify(x.d) !== JSON.stringify(y.d)) return false;
    }
    return JSON.stringify(contentTail(a)) === JSON.stringify(contentTail(b));
}
export function blendOf(item: PaintItem): Blend {
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
            const last = grid.populated.pop();
            if (last && last !== cell) { grid.populated[cell.slot] = last; last.slot = cell.slot; }
        }
        if (!column.size) grid.cells.delete(cx);
    }
}

function place(entry: Entry): void {
    if (entry.parts.length >= ORDER_SPAN) throw new RangeError('Paint item has too many parts to order');
    const base = entry.seq * ORDER_SPAN;
    for (let i = 0; i < entry.parts.length; i++) entry.parts[i].order = base + i;
    entry.placed = entry.seq;
}
function byOrder(a: IndexedPart, b: IndexedPart): number { return a.order - b.order; }
function sortByOrder(out: IndexedPart[]): void {
    if (out.length > INSERTION_SORT_MAX) { out.sort(byOrder); return; }
    for (let i = 1; i < out.length; i++) {
        const part = out[i];
        let j = i - 1;
        while (j >= 0 && out[j].order > part.order) { out[j + 1] = out[j]; j--; }
        out[j + 1] = part;
    }
}
function consider(out: IndexedPart[], part: IndexedPart, band: PaintBand, world: Readonly<Rect>, omit: ReadonlySet<string> | undefined, stamp: number): void {
    if (part.band !== band || part.mark === stamp || omit?.has(part.nodeId) || !reachesWorld(part.world, world)) return;
    part.mark = stamp;
    out.push(part);
}

export class OmitTracker {
    readonly #last = new Set<string>();
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
    let index: Index | null = null;
    let building: Build | null = null;
    let spare: Entry[] = [];
    let passes = 0;
    let pending: Rect[] = [];
    let pendingAll = false;
    let changesReady = false;
    let queryStamp = 0;
    /** The output of partsFor, reused: the caller copies it to keep it. */
    const out: IndexedPart[] = [];
    let boundsVersion = -1;
    let boundsIds = new Set<string>();
    let boundsRects: Rect[] = [];

    const reachesAnyRegion = (entry: Entry, build: Build): boolean => {
        if (!entry.bounds || !build.regionBox || !reachesWorld(entry.bounds, build.regionBox)) return false;
        for (const region of build.regions) if (reachesWorld(entry.bounds, region)) return true;
        return false;
    };

    const startDerive = (build: Build, band: PaintBand, item: PaintItem, blend: Blend, seq: number): void => {
        build.deriving = { band, item, blend, seq, contributions: paintContributions(item), index: 0, job: null, parts: [], bounds: null };
    };
    const advanceDerive = (build: Build): void => {
        const d = build.deriving!;
        if (d.index >= d.contributions.length) {
            const item = d.item;
            const entry: Entry = { item, band: d.band, nodeId: item.nodeId, key: item.key, blend: d.blend,
                epoch: item.kind === 'text' ? item.paint.fontEpoch : -1, parts: d.parts, bounds: d.bounds, seq: d.seq, placed: -1, stamp: 0 };
            build.deriving = null;
            build.next.push(entry);
            build.added.push(entry);
            return;
        }
        d.job ??= new PaintBoundsJob(d.contributions[d.index]);
        if (!d.job.step(256)) return;
        const world = d.job.result;
        d.job = null; d.index++;
        if (!world) return;
        d.parts.push({ band: d.band, order: 0, nodeId: d.item.nodeId, item: d.contributions[d.index - 1], world, blend: d.blend, mark: 0 });
        d.bounds = unionOf(d.bounds, world);
    };

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
                if (candidate.item === item || sameItemContent(candidate.item, item) || (!build.unknown && !reachesAnyRegion(candidate, build))) {
                    candidate.item = item; candidate.seq = seq; candidate.stamp = build.pass;
                    build.next.push(candidate);
                    return;
                }
                build.rederived++;
            } else if (!sameEpoch) build.epochs++;
            else build.rederived++;
            build.replaced++;
        }
        startDerive(build, band, item, blend, seq);
    };

    const startBuild = (prepared: PreparedPaint2d): Build => {
        const root = prepared.root, revision = root.sceneRevision;
        const cause = !index ? 'no-index' : index.theme !== root.theme ? 'theme' : index.variant !== root.rasterVariant ? 'variant' : null;
        const full = cause === 'no-index' || cause === 'theme';
        let regions: readonly Rect[] = NO_RECTS;
        let unknown = false;
        if (!full && index) {
            const changes = cause === 'variant' ? undefined : root.regionChangesSince?.(index.revision);
            if (!changes || changes.full) unknown = true;
            else regions = changes.regions;
        }
        let regionBox: Rect | null = null;
        for (const region of regions) regionBox = unionOf(regionBox, region);
        const target: Index = full || !index
            ? { version: 0, revision, original: null, theme: root.theme, variant: root.rasterVariant, windows: prepared.windows,
                entries: [], byNode: new Map(), grid: newGrid() }
            : index;
        const next = spare;
        next.length = 0;
        spare = [];
        if (unknown) auditCount(audit, 'index:unknown-span');
        if (cause === 'variant') auditCount(audit, 'index:variant');
        return { original: originalOf(prepared.sourceFrame), revision, theme: root.theme, variant: root.rasterVariant, windows: prepared.windows,
            old: full ? null : index, target, full, cause, deriving: null, prior: index !== null, unknown, regions, regionBox, pass: ++passes, next, added: [],
            window: 0, item: 0, seq: 0, replaced: 0, epochs: 0, rederived: 0 };
    };

    const step = (build: Build): boolean => {
        if (build.deriving) { advanceDerive(build); return false; }
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
            if (build.prior) pendingAll = true;
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
            auditCount(audit, `index:full:${build.cause ?? 'none'}`);
            auditCount(audit, 'parts:indexed', target.grid.count);
        } else {
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
        target.original = build.original;
        index = target;
        changesReady = true;
    };

    return {
        sync(prepared: PreparedPaint2d, budget: FrameBudget): boolean {
            const root = prepared.root;
            if (!building && index && index.revision === root.sceneRevision && index.theme === root.theme && index.variant === root.rasterVariant
                && (index.windows === prepared.windows || index.original === originalOf(prepared.sourceFrame))) {
                index.windows = prepared.windows;
                return true;
            }
            if (!building) building = startBuild(prepared);
            const build = building;
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
            const x0 = Math.floor(world.x / CELL), x1 = Math.floor((world.x + world.width) / CELL);
            const y0 = Math.floor(world.y / CELL), y1 = Math.floor((world.y + world.height) / CELL);
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
            if (pendingAll) { pendingAll = false; pending = []; auditCount(audit, 'index:take-all'); return 'all'; }
            if (!pending.length) return NO_RECTS;
            const taken = pending;
            pending = [];
            let area = 0;
            for (const rect of taken) area += rect.width * rect.height;
            auditCount(audit, 'index:take-rects', taken.length);
            auditCount(audit, 'index:take-area', area);
            return taken;
        },
        release(): void {
            index = null; building = null; spare = []; out.length = 0;
            pending = []; pendingAll = false; changesReady = false;
            boundsVersion = -1; boundsIds = new Set(); boundsRects = [];
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
