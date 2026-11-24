import { invertPageImageData } from './colour';

export interface ColourGroupRegion {
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
}

export interface ColourGroupBudget {
    shouldYield(): boolean;
    claim(bytes: number): boolean;
}

export interface ColourGroup2d {
    /** True only after the whole region has been transformed. No ImageData survives a step. */
    step(budget: ColourGroupBudget): boolean;
}

const CORE_SIZE = 256;
const MAX_GUARD = 8;

type GroupContext = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

/**
 * The caller owns the offscreen group and its lease, invalidates this job on snapshot change,
 * and keeps the prior display until it completes. claim meters transient CPU scratch, not uploads.
 * No ImageData is retained between steps, so abandoning a job holds no scratch (design §4.2:400–407).
 */
export function createColourGroup2d(ctx: GroupContext, region: ColourGroupRegion, guard = 1): ColourGroup2d {
    const { x, y, width, height } = region;
    if (![x, y, width, height, guard].every(Number.isSafeInteger) || x < 0 || y < 0 ||
        width < 0 || height < 0 || guard < 0 || guard > MAX_GUARD ||
        x + width > ctx.canvas.width || y + height > ctx.canvas.height) {
        throw new RangeError('Invalid offscreen colour group region');
    }
    if (typeof HTMLCanvasElement !== 'undefined' && ctx.canvas instanceof HTMLCanvasElement && ctx.canvas.isConnected) {
        throw new Error('Page inversion requires an offscreen group canvas');
    }
    let left = 0;
    let top = 0;
    return {
        step(budget): boolean {
            while (top < height && width > 0) {
                if (budget.shouldYield()) return false;
                const coreWidth = Math.min(CORE_SIZE, width - left);
                const coreHeight = Math.min(CORE_SIZE, height - top);
                const readX = Math.max(x, x + left - guard);
                const readY = Math.max(y, y + top - guard);
                const readRight = Math.min(x + width, x + left + coreWidth + guard);
                const readBottom = Math.min(y + height, y + top + coreHeight + guard);
                const readWidth = readRight - readX;
                const readHeight = readBottom - readY;
                if (!budget.claim(readWidth * readHeight * 4)) return false;
                const image = ctx.getImageData(readX, readY, readWidth, readHeight);
                invertPageImageData(image);
                // Write only the core: adjacent bands must not transform guard pixels twice (design §4.2:400).
                ctx.putImageData(image, readX, readY, x + left - readX, y + top - readY, coreWidth, coreHeight);
                left += coreWidth;
                if (left === width) {
                    left = 0;
                    top += coreHeight;
                }
            }
            return true;
        },
    };
}
