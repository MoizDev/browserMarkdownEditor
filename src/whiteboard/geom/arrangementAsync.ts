import type { Rect } from '../../platform/types';
import type { NodeSetOp, Transaction, TransactionOrigin } from '../change/ops';
import type { BoardDoc } from '../model/doc';
import type { NodeId } from '../model/ids';
import type { ArrangeItem, ArrangeMove, Axis } from './arrange';
import type { ArrangementAction, ArrangementServices } from './arrangement.types';
import { TranslationPlan } from './translation';

export interface ArrangementAsyncOptions {
    readonly signal: AbortSignal;
    readonly current: () => boolean;
    readonly cooperate?: () => Promise<void>;
    readonly origin?: TransactionOrigin;
}
interface Runner { check(): void; tick(): Promise<void>; due(): boolean }
function runner(options: ArrangementAsyncOptions): Runner {
    const cooperate = options.cooperate ?? (() => new Promise<void>(resolve => setTimeout(resolve, 0)));
    let count = 0, started = performance.now();
    const check = () => { options.signal.throwIfAborted(); if (!options.current()) throw new DOMException('Arrangement source changed', 'AbortError'); };
    return { check, due: () => ++count >= 256 || performance.now() - started >= 3,
        async tick() { check(); await cooperate(); check(); count = 0; started = performance.now(); } };
}
async function union(items: readonly ArrangeItem[], run: Runner): Promise<Rect | null> {
    if (!items.length) return null;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const { bounds, order } of items) {
        if (![bounds.x, bounds.y, bounds.width, bounds.height, bounds.x + bounds.width, bounds.y + bounds.height, order].every(Number.isFinite)
            || bounds.width < 0 || bounds.height < 0) throw new RangeError('Invalid arrangement bounds');
        x0 = Math.min(x0, bounds.x); y0 = Math.min(y0, bounds.y);
        x1 = Math.max(x1, bounds.x + bounds.width); y1 = Math.max(y1, bounds.y + bounds.height);
        if (run.due()) await run.tick();
    }
    const result = { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
    if (![result.x, result.y, result.width, result.height].every(Number.isFinite)) throw new RangeError('Arrangement extent overflows');
    return result;
}
async function stableSort<T>(input: readonly T[], compare: (a: T, b: T) => number, run: Runner): Promise<T[]> {
    let values: T[] = [], buffer = new Array<T>(input.length);
    for (const item of input) { values.push(item); if (run.due()) await run.tick(); }
    for (let width = 1; width < values.length; width *= 2) {
        for (let start = 0; start < values.length; start += width * 2) {
            const middle = Math.min(start + width, values.length), end = Math.min(start + width * 2, values.length);
            let left = start, right = middle;
            for (let i = start; i < end; i++) {
                buffer[i] = left < middle && (right >= end || compare(values[left], values[right]) <= 0) ? values[left++] : values[right++];
                if (run.due()) await run.tick();
            }
        }
        [values, buffer] = [buffer, values];
    }
    return values;
}
const moved = (id: NodeId, x: number, y: number): ArrangeMove => ({ id, delta: { x, y } });
async function align(items: readonly ArrangeItem[], box: Rect, mode: Extract<ArrangementAction, { kind: 'align' }>['mode'], run: Runner): Promise<ArrangeMove[]> {
    const result: ArrangeMove[] = [];
    for (const { id, bounds: b } of items) {
        let x = 0, y = 0;
        switch (mode) {
            case 'left': x = box.x - b.x; break;
            case 'center': x = box.x + box.width / 2 - b.x - b.width / 2; break;
            case 'right': x = box.x + box.width - b.x - b.width; break;
            case 'top': y = box.y - b.y; break;
            case 'middle': y = box.y + box.height / 2 - b.y - b.height / 2; break;
            case 'bottom': y = box.y + box.height - b.y - b.height; break;
        }
        if (![x, y].every(Number.isFinite)) throw new RangeError('Alignment overflows');
        if (x || y) result.push(moved(id, x, y));
        if (run.due()) await run.tick();
    }
    return result;
}
async function distribute(items: readonly ArrangeItem[], axis: Axis, run: Runner): Promise<ArrangeMove[]> {
    if (items.length < 3) return [];
    const horizontal = axis === 'horizontal', position = (item: ArrangeItem) => horizontal ? item.bounds.x : item.bounds.y;
    const extent = (item: ArrangeItem) => horizontal ? item.bounds.width : item.bounds.height;
    const ordered = await stableSort(items, (a, b) => position(a) + extent(a) / 2 - position(b) - extent(b) / 2
        || a.order - b.order || a.id.localeCompare(b.id), run);
    let total = 0; for (const item of ordered) { total += extent(item); if (run.due()) await run.tick(); }
    const first = ordered[0], last = ordered[ordered.length - 1];
    const gap = (position(last) + extent(last) - position(first) - total) / (ordered.length - 1);
    if (!Number.isFinite(gap)) throw new RangeError('Distribution gap overflows');
    const result: ArrangeMove[] = []; let next = position(first) + extent(first) + gap;
    for (let i = 1; i < ordered.length - 1; i++) {
        const item = ordered[i], delta = next - position(item);
        if (!Number.isFinite(delta)) throw new RangeError('Distribution placement overflows');
        if (delta) result.push(moved(item.id, horizontal ? delta : 0, horizontal ? 0 : delta));
        next += extent(item) + gap; if (run.due()) await run.tick();
    }
    return result;
}
async function stack(items: readonly ArrangeItem[], axis: Axis, run: Runner): Promise<ArrangeMove[]> {
    if (!items.length) return [];
    const horizontal = axis === 'horizontal', result: ArrangeMove[] = [];
    let next = horizontal ? items[0].bounds.x : items[0].bounds.y;
    for (const item of items) {
        const position = horizontal ? item.bounds.x : item.bounds.y, extent = horizontal ? item.bounds.width : item.bounds.height, delta = next - position;
        if (!Number.isFinite(delta)) throw new RangeError('Stack placement overflows');
        if (delta) result.push(moved(item.id, horizontal ? delta : 0, horizontal ? 0 : delta));
        next += extent + 10; if (run.due()) await run.tick();
    }
    if (!Number.isFinite(next)) throw new RangeError('Stack placement overflows');
    return result;
}
async function pack(items: readonly ArrangeItem[], before: Rect, run: Runner): Promise<ArrangeMove[]> {
    let area = 0, maxWidth = 0;
    for (const { bounds } of items) { area += (bounds.width + 10) * (bounds.height + 10); maxWidth = Math.max(maxWidth, bounds.width); if (run.due()) await run.tick(); }
    const width = Math.max(maxWidth, Math.sqrt(area)); if (!Number.isFinite(width)) throw new RangeError('Pack dimensions overflow');
    let capacity = 1; while (capacity < items.length) { capacity *= 2; if (!Number.isSafeInteger(capacity)) throw new RangeError('Pack index is too large'); }
    const tree = new Float64Array(capacity * 2), free: number[] = [], heights: number[] = [];
    for (let i = 0; i < tree.length; i++) { tree[i] = -Infinity; if (run.due()) await run.tick(); }
    const placements: { item: ArrangeItem; row: number; x: number }[] = [];
    for (const item of items) {
        let row: number;
        if (tree[1] < item.bounds.width) { row = free.length; free.push(width); heights.push(0); }
        else { let i = 1; while (i < capacity) i = tree[2 * i] >= item.bounds.width ? 2 * i : 2 * i + 1; row = i - capacity; }
        const x = width - free[row]; placements.push({ item, row, x });
        free[row] -= item.bounds.width + 10; heights[row] = Math.max(heights[row], item.bounds.height);
        let i = capacity + row; tree[i] = free[row];
        while (i > 1) { i >>= 1; tree[i] = Math.max(tree[2 * i], tree[2 * i + 1]); }
        if (run.due()) await run.tick();
    }
    const y: number[] = []; let top = 0;
    for (const height of heights) { y.push(top); top += height + 10; if (run.due()) await run.tick(); }
    let maxX = 0, maxY = 0;
    for (const item of placements) { maxX = Math.max(maxX, item.x + item.item.bounds.width); maxY = Math.max(maxY, y[item.row] + item.item.bounds.height); if (run.due()) await run.tick(); }
    const offsetX = before.x + before.width / 2 - maxX / 2, offsetY = before.y + before.height / 2 - maxY / 2;
    if (![offsetX, offsetY].every(Number.isFinite)) throw new RangeError('Pack placement overflows');
    const result: ArrangeMove[] = [];
    for (const p of placements) {
        const dx = offsetX + p.x - p.item.bounds.x, dy = offsetY + y[p.row] - p.item.bounds.y;
        if (![dx, dy].every(Number.isFinite)) throw new RangeError('Pack placement overflows');
        if (dx || dy) result.push(moved(p.item.id, dx, dy));
        if (run.due()) await run.tick();
    }
    return result;
}

/** Same actual logical geometry and transaction as the synchronous planner,
 * without an unsliced sort, pack build, or translation-plan fanout. */
export async function arrangementTransactionAsync(doc: BoardDoc, selected: readonly NodeId[], action: ArrangementAction,
    services: ArrangementServices, options: ArrangementAsyncOptions): Promise<Transaction> {
    const run = runner(options), revision = doc.rev, host = doc.host; run.check();
    const check = () => { run.check(); if (doc.rev !== revision || doc.host !== host) throw new DOMException('Arrangement document changed', 'AbortError'); };
    const items: ArrangeItem[] = [], unique = new Set<NodeId>();
    for (const id of selected) {
        check(); if (!unique.has(id)) { unique.add(id); items.push({ id, bounds: services.logicalBounds(id), order: services.rank(id) }); }
        if (run.due()) await run.tick();
    }
    const box = await union(items, run); check();
    if (!box) return { origin: options.origin ?? 'tool', label: `Arrange ${action.kind}`, ops: [] };
    let moves: readonly ArrangeMove[];
    switch (action.kind) {
        case 'align': moves = await align(items, box, action.mode, run); break;
        case 'distribute': moves = await distribute(items, action.axis, run); break;
        case 'stack': moves = await stack(items, action.axis, run); break;
        case 'pack': moves = await pack(items, box, run); break;
    }
    const ops: NodeSetOp[] = [];
    for (const move of moves) {
        check(); const plan = new TranslationPlan(doc, [move.id], services.geometry);
        try { for (const op of plan.preview(move.delta).ops) { if (op.t !== 'set') throw new Error('Arrangement produced a non-set operation'); ops.push(op); } }
        finally { plan.cancel(); }
        if (run.due()) await run.tick();
    }
    check(); return { origin: options.origin ?? 'tool', label: `Arrange ${action.kind}`, ops };
}
