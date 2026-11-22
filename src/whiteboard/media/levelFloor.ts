import type { MediaId } from '../model/media';

// The coarsest-needed level the pool can actually give a picture at one zoom. The tile plan starts from the finest level its view
// needs; when the painter's tiles at that level are refused for memory, the next plan for the same picture at the same device scale
// takes the next coarser level, so a refused picture sharpens as far as the pool allows instead of staying on its stand-in
// (measured: an 8000x6000 picture at 100%, DPR 2, planned six level-0 tiles, 24 MB, every one refused beside the selection's
// prepared copy; the view showed only the level-3 stand-in). A zoom asks at another device scale and starts from the finest again.

interface Floor { readonly scale: number; readonly level: number }
const floors = new Map<MediaId, Floor>();
const planned = new Map<MediaId, number>();
/** Bounded like the pictures a board holds at once; the oldest entry goes first. */
const MAX_ENTRIES = 256;

function sameScale(a: number, b: number): boolean { return Math.abs(a - b) <= 0.01 * Math.max(a, b); }
function remember<T>(map: Map<MediaId, T>, id: MediaId, value: T): void {
    map.delete(id); map.set(id, value);
    if (map.size > MAX_ENTRIES) map.delete(map.keys().next().value!);
}

/** The level a plan at this device scale starts from: the finest the pool has not refused at this scale. */
export function pictureLevelFloor(id: MediaId, deviceScale: number): number {
    remember(planned, id, deviceScale);
    const floor = floors.get(id);
    return floor && sameScale(floor.scale, deviceScale) ? floor.level : 0;
}

/** A tile at `level` was refused for memory: plans at the last planned scale start one level coarser. True when that raised the floor. */
export function pictureLevelRefused(id: MediaId, level: number): boolean {
    const scale = planned.get(id);
    if (scale === undefined) return false;
    const floor = floors.get(id), current = floor && sameScale(floor.scale, scale) ? floor.level : 0;
    if (level + 1 <= current) return false;
    remember(floors, id, { scale, level: level + 1 });
    return true;
}
