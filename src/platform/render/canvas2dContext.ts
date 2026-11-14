import type { Rect } from '../types';

export type CanvasImageCall = (source: CanvasImageSource, sourceRect: Rect, destRect: Rect, draw: () => void) => void;

export function imageExtent(source: CanvasImageSource): { width: number; height: number } {
    if (source instanceof HTMLVideoElement) return { width: source.videoWidth, height: source.videoHeight };
    if (source instanceof HTMLImageElement) return { width: source.naturalWidth, height: source.naturalHeight };
    if (source instanceof SVGImageElement) return { width: source.width.baseVal.value, height: source.height.baseVal.value };
    if (typeof VideoFrame !== 'undefined' && source instanceof VideoFrame) return { width: source.displayWidth, height: source.displayHeight };
    return { width: (source as ImageBitmap).width, height: (source as ImageBitmap).height };
}

/** A bounded effect/band still exposes DEVICE identity to a layer. Its native backing starts at
 * (-origin), including when a shared scope installs an absolute transform. Binding every native
 * method preserves the browser's context brand; a producer never sees a second RAF or canvas owner.
 */
export function deviceContext(native: CanvasRenderingContext2D, origin: { x: number; y: number }, image: CanvasImageCall): CanvasRenderingContext2D {
    const methods = new Map<PropertyKey, unknown>();
    const reset = () => native.setTransform(1, 0, 0, 1, -origin.x, -origin.y);
    reset();
    return new Proxy(native, {
        get(target, key) {
            if (key === 'resetTransform') return reset;
            if (key === 'setTransform') return (...args: unknown[]) => {
                const matrix = args.length === 6 ? new DOMMatrix(args as number[]) : DOMMatrix.fromMatrix(args[0] as DOMMatrixInit | undefined);
                target.setTransform(matrix.a, matrix.b, matrix.c, matrix.d, matrix.e - origin.x, matrix.f - origin.y);
            };
            if (key === 'getTransform') return () => {
                const matrix = target.getTransform();
                matrix.e += origin.x; matrix.f += origin.y;
                return matrix;
            };
            if (key === 'drawImage') return (source: CanvasImageSource, ...args: number[]) => {
                const extent = imageExtent(source);
                let src: Rect;
                let dst: Rect;
                if (args.length === 2 || args.length === 4) {
                    src = { x: 0, y: 0, ...extent };
                    dst = { x: args[0], y: args[1], width: args[2] ?? extent.width, height: args[3] ?? extent.height };
                } else if (args.length === 8) {
                    src = { x: args[0], y: args[1], width: args[2], height: args[3] };
                    dst = { x: args[4], y: args[5], width: args[6], height: args[7] };
                } else throw new TypeError('Invalid drawImage arguments');
                // Native Canvas normalizes negative extents without flipping the image.
                if (src.width < 0) { src.x += src.width; src.width = -src.width; }
                if (src.height < 0) { src.y += src.height; src.height = -src.height; }
                if (dst.width < 0) { dst.x += dst.width; dst.width = -dst.width; }
                if (dst.height < 0) { dst.y += dst.height; dst.height = -dst.height; }
                if (!src.width || !src.height || !dst.width || !dst.height) return;
                image(source, src, dst, () => target.drawImage(source, src.x, src.y, src.width, src.height, dst.x, dst.y, dst.width, dst.height));
            };
            const value = Reflect.get(target, key, target);
            if (typeof value !== 'function') return value;
            if (!methods.has(key)) methods.set(key, value.bind(target));
            return methods.get(key);
        },
        set(target, key, value) { return Reflect.set(target, key, value, target); },
    });
}
