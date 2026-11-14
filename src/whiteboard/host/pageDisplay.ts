import type { PageDisplayList, Rect } from '../../platform/types';
import { paintFrameDisplayList, type ExportImage } from '../export/displayList';
import type { PaintFrame } from '../render/paintStream';

/** Translate world-space paint to the page once, then clip it to physical paper. */
export async function pageDisplayList(
    frame: PaintFrame, page: number, box: Readonly<Rect>, scale: number, image: ExportImage, signal?: AbortSignal,
): Promise<PageDisplayList> {
    const world = await paintFrameDisplayList(frame, page, scale, image, signal);
    signal?.throwIfAborted();
    return { page, items: [{ kind: 'group',
        clip: { d: [['M', 0, 0], ['L', box.width, 0], ['L', box.width, box.height], ['L', 0, box.height], ['Z']] },
        items: [{ kind: 'group', transform: [1, 0, 0, 1, -box.x, -box.y], items: world.items }],
    }] };
}
