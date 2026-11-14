import type { Rect } from '../../platform/types';
import type { NodeId } from '../model/ids';
import type { Vec2 } from './path';

export interface ArrangeItem { readonly id: NodeId; readonly bounds: Rect; readonly order: number }
export interface ArrangeMove { readonly id: NodeId; readonly delta: Vec2 }
export type Align = 'left' | 'center' | 'right' | 'top' | 'middle' | 'bottom';
export type Axis = 'horizontal' | 'vertical';
function validate(items: readonly ArrangeItem[]): void {
    for (const { bounds: b, order } of items) if (![b.x, b.y, b.width, b.height, order].every(Number.isFinite) || b.width < 0 || b.height < 0) throw new RangeError('Invalid arrangement bounds');
}
function union(items: readonly ArrangeItem[]): Rect | null {
    if (!items.length) return null;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const { bounds: b } of items) { x0 = Math.min(x0, b.x); y0 = Math.min(y0, b.y); x1 = Math.max(x1, b.x + b.width); y1 = Math.max(y1, b.y + b.height); }
    if (![x0, y0, x1, y1].every(Number.isFinite)) throw new RangeError('Arrangement bounds overflow');
    return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}
function move(id: NodeId, x: number, y: number): ArrangeMove { return { id, delta: { x, y } }; }
export function align(items: readonly ArrangeItem[], mode: Align): readonly ArrangeMove[] {
    validate(items); const box = union(items);
    if (!box) return [];
    return items.map(({ id, bounds: b }) => {
        switch (mode) {
            case 'left': return move(id, box.x - b.x, 0);
            case 'center': return move(id, box.x + box.width / 2 - b.x - b.width / 2, 0);
            case 'right': return move(id, box.x + box.width - b.x - b.width, 0);
            case 'top': return move(id, 0, box.y - b.y);
            case 'middle': return move(id, 0, box.y + box.height / 2 - b.y - b.height / 2);
            case 'bottom': return move(id, 0, box.y + box.height - b.y - b.height);
        }
    }).filter(m => m.delta.x !== 0 || m.delta.y !== 0);
}
export function distribute(items: readonly ArrangeItem[], axis: Axis): readonly ArrangeMove[] {
    validate(items); if (items.length < 3) return [];
    const horizontal = axis === 'horizontal';
    const position = (item: ArrangeItem) => horizontal ? item.bounds.x : item.bounds.y;
    const extent = (item: ArrangeItem) => horizontal ? item.bounds.width : item.bounds.height;
    const sorted = [...items].sort((a, b) => position(a) + extent(a) / 2 - position(b) - extent(b) / 2 || a.order - b.order || a.id.localeCompare(b.id));
    const first = sorted[0], last = sorted[sorted.length - 1];
    const total = sorted.reduce((sum, item) => sum + extent(item), 0);
    const gap = (position(last) + extent(last) - position(first) - total) / (sorted.length - 1);
    if (!Number.isFinite(gap)) throw new RangeError('Arrangement gap overflows');
    const result: ArrangeMove[] = [];
    let next = position(first) + extent(first) + gap;
    for (let i = 1; i < sorted.length - 1; i++) {
        const item = sorted[i], delta = next - position(item);
        if (delta) result.push(move(item.id, horizontal ? delta : 0, horizontal ? 0 : delta));
        next += extent(item) + gap;
    }
    return result;
}
export interface StretchTarget { readonly id: NodeId; readonly axis: Axis; readonly origin: number; readonly extent: number }
export function stretch(items: readonly ArrangeItem[], axis: Axis): readonly StretchTarget[] {
    validate(items); const box = union(items);
    if (!box) return [];
    const origin = axis === 'horizontal' ? box.x : box.y, extent = axis === 'horizontal' ? box.width : box.height;
    return items.map(({ id }) => ({ id, axis, origin, extent }));
}
export function stack(items: readonly ArrangeItem[], axis: Axis, gap = 10): readonly ArrangeMove[] {
    validate(items); if (!Number.isFinite(gap) || gap < 0) throw new RangeError('Invalid stack gap');
    if (!items.length) return [];
    const horizontal = axis === 'horizontal';
    let next = horizontal ? items[0].bounds.x : items[0].bounds.y;
    const result: ArrangeMove[] = [];
    for (const item of items) {
        const position = horizontal ? item.bounds.x : item.bounds.y, extent = horizontal ? item.bounds.width : item.bounds.height;
        const delta = next - position;
        if (delta) result.push(move(item.id, horizontal ? delta : 0, horizontal ? 0 : delta));
        next += extent + gap;
    }
    if (!Number.isFinite(next)) throw new RangeError('Stack placement overflows');
    return result;
}
export function pack(items: readonly ArrangeItem[], gap = 10): readonly ArrangeMove[] {
    validate(items); if (!Number.isFinite(gap) || gap < 0) throw new RangeError('Invalid pack gap');
    const before = union(items); if (!before) return [];
    let area = 0, maxWidth = 0;
    for (const { bounds: b } of items) { area += (b.width + gap) * (b.height + gap); maxWidth = Math.max(maxWidth, b.width); }
    const width = Math.max(maxWidth, Math.sqrt(area));
    if (!Number.isFinite(width)) throw new RangeError('Pack dimensions overflow');
    let capacity = 1; while (capacity < items.length) capacity *= 2;
    const tree = new Float64Array(capacity * 2).fill(-Infinity), free: number[] = [], heights: number[] = [];
    const placements: { item: ArrangeItem; row: number; x: number }[] = [];
    const update = (row: number, value: number) => {
        let i = capacity + row; tree[i] = value;
        while (i > 1) { i >>= 1; tree[i] = Math.max(tree[2 * i], tree[2 * i + 1]); }
    };
    for (const item of items) {
        let row: number;
        if (tree[1] < item.bounds.width) { row = free.length; free.push(width); heights.push(0); }
        else {
            let i = 1;
            while (i < capacity) i = tree[2 * i] >= item.bounds.width ? 2 * i : 2 * i + 1;
            row = i - capacity;
        }
        const x = width - free[row]; placements.push({ item, row, x });
        free[row] -= item.bounds.width + gap; heights[row] = Math.max(heights[row], item.bounds.height);
        update(row, free[row]);
    }
    const y: number[] = []; let top = 0;
    for (const height of heights) { y.push(top); top += height + gap; }
    let maxX = 0, maxY = 0;
    for (const p of placements) { maxX = Math.max(maxX, p.x + p.item.bounds.width); maxY = Math.max(maxY, y[p.row] + p.item.bounds.height); }
    const offsetX = before.x + before.width / 2 - maxX / 2, offsetY = before.y + before.height / 2 - maxY / 2;
    if (![offsetX, offsetY].every(Number.isFinite)) throw new RangeError('Pack placement overflows');
    return placements.map(p => move(p.item.id, offsetX + p.x - p.item.bounds.x, offsetY + y[p.row] - p.item.bounds.y))
        .filter(m => m.delta.x !== 0 || m.delta.y !== 0);
}
