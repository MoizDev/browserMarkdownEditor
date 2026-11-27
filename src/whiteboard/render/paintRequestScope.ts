import type { Rect } from '../../platform/types';
import { chooseTileScale } from './tileHierarchy';

export function pictureTileWorld(request: { readonly viewWorld?: Readonly<Rect>; readonly world?: Readonly<Rect> }): Readonly<Rect> | undefined {
    const v = request.viewWorld;
    if (!v) return request.world;
    const mx = v.width / 8, my = v.height / 8;
    return { x: v.x - mx, y: v.y - my, width: v.width + 2 * mx, height: v.height + 2 * my };
}

export function inkRealisationScale(deviceScale: number, sensitive: boolean): number {
    return chooseTileScale(deviceScale * (sensitive ? 2.5 : 1)).scale;
}

export function inkRealisationNear(a: number, b: number, within: 0 | 1): boolean {
    const near = (x: number, y: number) => within === 0 ? x === y : Math.max(x / y, y / x) <= Math.SQRT2 * (1 + 1e-9);
    return near(inkRealisationScale(a, false), inkRealisationScale(b, false)) && near(inkRealisationScale(a, true), inkRealisationScale(b, true));
}
