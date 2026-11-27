import type { MediaId } from '../model/media';

interface Floor { readonly scale: number; readonly level: number }
const floors = new Map<MediaId, Floor>();
const planned = new Map<MediaId, number>();
const MAX_ENTRIES = 256;

function sameScale(a: number, b: number): boolean { return Math.abs(a - b) <= 0.01 * Math.max(a, b); }
function remember<T>(map: Map<MediaId, T>, id: MediaId, value: T): void {
    map.delete(id); map.set(id, value);
    if (map.size > MAX_ENTRIES) map.delete(map.keys().next().value!);
}

export function pictureLevelFloor(id: MediaId, deviceScale: number): number {
    remember(planned, id, deviceScale);
    const floor = floors.get(id);
    return floor && sameScale(floor.scale, deviceScale) ? floor.level : 0;
}

export function pictureLevelRefused(id: MediaId, level: number): boolean {
    const scale = planned.get(id);
    if (scale === undefined) return false;
    const floor = floors.get(id), current = floor && sameScale(floor.scale, scale) ? floor.level : 0;
    if (level + 1 <= current) return false;
    remember(floors, id, { scale, level: level + 1 });
    return true;
}
