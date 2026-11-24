import type { Rect } from '../../platform/types';
import { chooseTileScale } from './tileHierarchy';

// What a paint request's view and device scale decide in the stream it opens. Shared by the paint services, which build the stream,
// and the board view, which keeps a canvas2d request standing while a new one would bring back the same stream.

/** Picture tiles cover what is on screen and an eighth of the view around it; without a view rect, the frame's world. */
export function pictureTileWorld(request: { readonly viewWorld?: Readonly<Rect>; readonly world?: Readonly<Rect> }): Readonly<Rect> | undefined {
    const v = request.viewWorld;
    if (!v) return request.world;
    const mx = v.width / 8, my = v.height / 8;
    return { x: v.x - mx, y: v.y - my, width: v.width + 2 * mx, height: v.height + 2 * my };
}

/** The device scale a stroke is realised at: the tile ladder's band over the request's scale, 2.5 times finer for a sensitive node. */
export function inkRealisationScale(deviceScale: number, sensitive: boolean): number {
    return chooseTileScale(deviceScale * (sensitive ? 2.5 : 1)).scale;
}

/** Two device scales realise every stroke alike (`within` 0) or at most `within` √2 bands apart, sensitive or not. Ink is the only part of
 * a stream without pictures that reads the scale: vectors, text and connectors resolve alike at any scale, and the 2D adapter flattens
 * their paths at the exact one. */
export function inkRealisationNear(a: number, b: number, within: 0 | 1): boolean {
    const near = (x: number, y: number) => within === 0 ? x === y : Math.max(x / y, y / x) <= Math.SQRT2 * (1 + 1e-9);
    return near(inkRealisationScale(a, false), inkRealisationScale(b, false)) && near(inkRealisationScale(a, true), inkRealisationScale(b, true));
}
