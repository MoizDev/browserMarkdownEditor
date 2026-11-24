import { pageAt, pageStack } from '../../platform/render';
import type { PageStack, Rect } from '../../platform/render';

export { pageAt, pageStack };
export type { PageStack };

/** The shared platform stack assigns a gap to the next page (contracts C1.5:213–223). */
export function pagePosition(stack: Readonly<PageStack>, world: Readonly<{ x: number; y: number }>):
    { page: number; x: number; y: number } | null {
    if (!Number.isFinite(world.x) || !Number.isFinite(world.y)) throw new RangeError('Invalid world position');
    const page = pageAt(stack, world.y);
    if (page < 0) return null;
    const rect: Readonly<Rect> = stack.rects[page];
    return { page, x: world.x - rect.x, y: world.y - rect.y };
}

/** Keep hit coordinates in world units; a gap or a horizontal margin is not page content. */
export function pageHit(stack: Readonly<PageStack>, world: Readonly<{ x: number; y: number }>):
    { page: number; x: number; y: number } | null {
    const position = pagePosition(stack, world);
    if (!position) return null;
    const rect = stack.rects[position.page];
    return position.x >= 0 && position.y >= 0 && position.x < rect.width && position.y < rect.height ? position : null;
}
