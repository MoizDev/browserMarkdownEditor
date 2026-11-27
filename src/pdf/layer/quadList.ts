import type { Rect } from '../../platform/render';
import type { TexturedQuadSpec } from '../../platform/render/compositor.types';

export const QUAD_BATCH_LIMIT = 2048;

export class QuadList {
    private readonly slots: { sourceRect: Rect; destRect: Rect }[] = [];
    private readonly window: { sourceRect: Rect; destRect: Rect }[] = [];
    readonly items: { sourceRect: Rect; destRect: Rect }[] = [];

    reset(): void {
        this.items.length = 0;
    }

    add(source: Readonly<Rect>, destination: Readonly<Rect>): void {
        const index = this.items.length;
        let slot = this.slots[index];
        if (!slot) {
            slot = { sourceRect: { x: 0, y: 0, width: 0, height: 0 }, destRect: { x: 0, y: 0, width: 0, height: 0 } };
            this.slots.push(slot);
        }
        slot.sourceRect.x = source.x;
        slot.sourceRect.y = source.y;
        slot.sourceRect.width = source.width;
        slot.sourceRect.height = source.height;
        slot.destRect.x = destination.x;
        slot.destRect.y = destination.y;
        slot.destRect.width = destination.width;
        slot.destRect.height = destination.height;
        this.items.push(slot);
    }

    drawAll(draw: (quads: readonly TexturedQuadSpec[]) => void): void {
        for (let start = 0; start < this.items.length; start += QUAD_BATCH_LIMIT) {
            const end = Math.min(this.items.length, start + QUAD_BATCH_LIMIT);
            this.window.length = 0;
            for (let index = start; index < end; index++) this.window.push(this.items[index]);
            draw(this.window);
        }
    }
}
