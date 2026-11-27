import type { Rect } from '../../platform/types';

export const DENSE_TILE_PIXELS = 512;
export type TilePyramid = 0 | 1;
export interface TileAddress { readonly pyramid: TilePyramid; readonly level: number; readonly x: number; readonly y: number }
export interface TileScale { readonly pyramid: TilePyramid; readonly level: number; readonly scale: number }
const ROOT_TWO = Math.SQRT2;
const MIN_LEVEL = -1010;
const MAX_LEVEL = 1010;

function validateAddress(address: TileAddress): void {
    if ((address.pyramid !== 0 && address.pyramid !== 1) || !Number.isInteger(address.level)
        || address.level < MIN_LEVEL || address.level > MAX_LEVEL
        || !Number.isSafeInteger(address.x) || !Number.isSafeInteger(address.y)) throw new RangeError('Invalid dense tile address');
}
export function tileScale(pyramid: TilePyramid, level: number): number {
    validateAddress({ pyramid, level, x: 0, y: 0 });
    return 2 ** level * (pyramid ? ROOT_TWO : 1);
}
export function chooseTileScale(actual: number): TileScale {
    if (!Number.isFinite(actual) || actual <= 0) throw new RangeError('Invalid dense tile scale');
    let band = Math.ceil(2 * Math.log2(actual));
    let level = Math.floor(band / 2), pyramid = (band - 2 * level) as TilePyramid;
    let scale = tileScale(pyramid, level);
    if (scale < actual) { band++; level = Math.floor(band / 2); pyramid = (band - 2 * level) as TilePyramid; scale = tileScale(pyramid, level); }
    if (band > 2 * MIN_LEVEL) {
        const previous = band - 1, previousLevel = Math.floor(previous / 2), previousPyramid = (previous - 2 * previousLevel) as TilePyramid;
        const previousScale = tileScale(previousPyramid, previousLevel);
        if (previousScale >= actual) { level = previousLevel; pyramid = previousPyramid; scale = previousScale; }
    }
    return Object.freeze({ pyramid, level, scale });
}
export function tileParent(address: TileAddress): TileAddress {
    validateAddress(address);
    if (address.level === MIN_LEVEL) throw new RangeError('Dense tile has no representable parent');
    return Object.freeze({ pyramid: address.pyramid, level: address.level - 1, x: Math.floor(address.x / 2), y: Math.floor(address.y / 2) });
}
export function tileChildren(address: TileAddress): readonly TileAddress[] {
    validateAddress(address);
    if (address.level === MAX_LEVEL || !Number.isSafeInteger(address.x * 2 + 1) || !Number.isSafeInteger(address.y * 2 + 1)) {
        throw new RangeError('Dense tile children exceed the address range');
    }
    const x = address.x * 2, y = address.y * 2, level = address.level + 1, pyramid = address.pyramid;
    return Object.freeze([{ pyramid, level, x, y }, { pyramid, level, x: x + 1, y },
        { pyramid, level, x, y: y + 1 }, { pyramid, level, x: x + 1, y: y + 1 }].map(child => Object.freeze(child)));
}
export function tileRectWorld(address: TileAddress): Readonly<Rect> {
    validateAddress(address);
    const side = DENSE_TILE_PIXELS / tileScale(address.pyramid, address.level);
    const x = address.x * side, y = address.y * side;
    if (![x, y, side, x + side, y + side].every(Number.isFinite)) throw new RangeError('Dense tile world bounds overflow');
    return Object.freeze({ x, y, width: side, height: side });
}

export interface TileRecord<T> {
    readonly address: TileAddress;
    readonly interval: string;
    readonly revision: number;
    readonly complete: true;
    readonly stale: boolean;
    readonly payload: T;
}
export interface TileTicket { readonly address: TileAddress; readonly interval: string; readonly revision: number }
interface IntervalState { revision: number; epoch: number }
const key = (interval: string, address: TileAddress) => JSON.stringify([interval, address.pyramid, address.level, address.x, address.y]);
function checkRevision(revision: number): void {
    if (!Number.isSafeInteger(revision) || revision < 0) throw new RangeError('Invalid tile revision');
}
function checkRect(rect: Readonly<Rect>): void {
    if (![rect.x, rect.y, rect.width, rect.height, rect.x + rect.width, rect.y + rect.height].every(Number.isFinite)
        || rect.width < 0 || rect.height < 0) throw new RangeError('Invalid tile invalidation bounds');
}
function intersects(a: Readonly<Rect>, b: Readonly<Rect>): boolean {
    return a.x <= b.x + b.width && b.x <= a.x + a.width && a.y <= b.y + b.height && b.y <= a.y + a.height;
}

export class TileHierarchy<T> {
    private readonly intervals = new Map<string, IntervalState>();
    private readonly records = new Map<string, TileRecord<T>>();
    private readonly levels = new Map<string, Map<number, number>>();
    private readonly pending = new Map<string, { ticket: TileTicket; epoch: number }>();
    constructor(private readonly onRetire: (record: TileRecord<T>) => void) {}
    begin(interval: string, address: TileAddress, revision: number): TileTicket {
        validateAddress(address); checkRevision(revision);
        let state = this.intervals.get(interval);
        if (!state) { state = { revision, epoch: 0 }; this.intervals.set(interval, state); }
        if (state.revision !== revision) throw new RangeError('Tile build revision is not current');
        const ticket = Object.freeze({ interval, address: Object.freeze({ ...address }), revision });
        this.pending.set(key(interval, address), { ticket, epoch: state.epoch });
        return ticket;
    }
    cancel(ticket: TileTicket): void {
        const id = key(ticket.interval, ticket.address);
        if (this.pending.get(id)?.ticket === ticket) this.pending.delete(id);
    }
    /** On false the staging payload remains the caller's; it was never published. */
    publish(ticket: TileTicket, payload: T): boolean {
        const id = key(ticket.interval, ticket.address), pending = this.pending.get(id), state = this.intervals.get(ticket.interval);
        if (!pending || pending.ticket !== ticket || !state || state.revision !== ticket.revision || state.epoch !== pending.epoch) return false;
        this.pending.delete(id);
        const previous = this.records.get(id);
        const record: TileRecord<T> = Object.freeze({ address: ticket.address, interval: ticket.interval,
            revision: ticket.revision, complete: true, stale: false, payload });
        this.records.set(id, record);
        if (!previous) {
            let levels = this.levels.get(ticket.interval);
            if (!levels) { levels = new Map(); this.levels.set(ticket.interval, levels); }
            levels.set(ticket.address.level, (levels.get(ticket.address.level) ?? 0) + 1);
        }
        if (previous) this.onRetire(previous);
        return true;
    }
    lookupAncestor(interval: string, address: TileAddress, allowStale = false): TileRecord<T> | null {
        validateAddress(address);
        const levels = this.levels.get(interval);
        if (!levels?.size) return null;
        let minimum = address.level;
        for (const level of levels.keys()) minimum = Math.min(minimum, level);
        let current = address;
        for (;;) {
            const found = this.records.get(key(interval, current));
            if (found && (allowStale || !found.stale)) return found;
            if (current.level === minimum) return null;
            current = tileParent(current);
        }
    }
    invalidateRegions(interval: string, revision: number, regions: readonly Rect[]): void {
        for (const region of regions) checkRect(region);
        this.invalidateMatching(interval, revision, record => {
            const tile = tileRectWorld(record.address), bleed = 2 / tileScale(record.address.pyramid, record.address.level);
            const padded = { x: tile.x - bleed, y: tile.y - bleed, width: tile.width + 2 * bleed, height: tile.height + 2 * bleed };
            return regions.some(region => intersects(padded, region));
        });
    }
    invalidateOrder(interval: string, revision: number): void { this.invalidateMatching(interval, revision, () => true); }
    private invalidateMatching(interval: string, revision: number, affected: (record: TileRecord<T>) => boolean): void {
        checkRevision(revision);
        const state = this.intervals.get(interval);
        if (state && revision < state.revision) throw new RangeError('Tile revision moved backwards');
        this.intervals.set(interval, { revision, epoch: (state?.epoch ?? 0) + 1 });
        for (const [id, record] of this.records) {
            if (record.interval === interval && !record.stale && affected(record)) this.records.set(id, Object.freeze({ ...record, stale: true }));
        }
        for (const [id, pending] of this.pending) if (pending.ticket.interval === interval) this.pending.delete(id);
    }
    retire(interval: string, address: TileAddress): void {
        validateAddress(address);
        const id = key(interval, address), record = this.records.get(id);
        if (!record) return;
        this.records.delete(id);
        const levels = this.levels.get(interval)!;
        const count = levels.get(address.level)! - 1;
        if (count) levels.set(address.level, count); else levels.delete(address.level);
        if (!levels.size) this.levels.delete(interval);
        this.onRetire(record);
    }
    clear(): void {
        const records = [...this.records.values()];
        this.records.clear(); this.pending.clear(); this.intervals.clear(); this.levels.clear();
        const errors: unknown[] = [];
        for (const record of records) { try { this.onRetire(record); } catch (error) { errors.push(error); } }
        if (errors.length) throw new AggregateError(errors, 'Failed to retire dense tiles');
    }
}
