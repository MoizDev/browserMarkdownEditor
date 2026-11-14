import { deviceContext } from './canvas2dContext';
import type { CanvasImageCall } from './canvas2dContext';

const mirroredMethods = new Set<PropertyKey>([
    'save', 'restore', 'resetTransform', 'setTransform', 'transform', 'translate', 'rotate', 'scale',
    'beginPath', 'closePath', 'moveTo', 'lineTo', 'bezierCurveTo', 'quadraticCurveTo', 'arc', 'arcTo',
    'ellipse', 'rect', 'roundRect', 'clip',
]);

/** The witness shares geometry and clipping, but never receives document paint. */
export function benchmarkDeviceContext(native: CanvasRenderingContext2D, origin: { x: number; y: number },
    imageCallback: CanvasImageCall, witnessNative: CanvasRenderingContext2D, onWitnessFailure?: () => void): CanvasRenderingContext2D {
    const context = deviceContext(native, origin, imageCallback);
    if (!__BME_BENCH__) return context;
    const witness = deviceContext(witnessNative, origin, (_source, _src, _dst, draw) => draw());
    const methods = new Map<PropertyKey, unknown>();
    return new Proxy(context, {
        get(target, key) {
            const value = Reflect.get(target, key, target);
            if (typeof value !== 'function' || !mirroredMethods.has(key)) return value;
            if (!methods.has(key)) methods.set(key, (...args: unknown[]) => {
                const result = Reflect.apply(value, target, args);
                try { Reflect.apply(Reflect.get(witness, key, witness), witness, args); }
                catch { try { onWitnessFailure?.(); } catch { /* Witness failure must not alter product paint. */ } }
                return result;
            });
            return methods.get(key);
        },
        set(target, key, value) { return Reflect.set(target, key, value, target); },
    });
}
