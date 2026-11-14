import type { Rect, ViewState } from '../types';
import type { CompositorResources, LayerAllocators, LayerHost, PaneCompositor, TexturedQuadOptions } from './compositor.types';
import type { GpuPass, TextureHandle, UniformSlice } from './gfx/api';

export interface LayerHostBindings {
    readonly allocator: LayerAllocators;
    generation(): number;
    /** Qualified rebuilding GPU, even while the selected presentation is still CPU. */
    gpuResources(): CompositorResources | null;
    compositor(): PaneCompositor | null;
    invalidate(reason: string): void;
    wakeAt(deadlineMs: number | null): void;
}

/** One stable host per layer. Accessors consult the live qualified generation, never the
 * compositor captured at layer creation; backend switches retain the same layer objects.
 */
export function createLayerHost(bindings: LayerHostBindings): LayerHost {
    const resources = (): CompositorResources => {
        const current = bindings.gpuResources();
        if (!current) throw new Error('The compositor resources are unavailable');
        return current;
    };
    const compositor = (): PaneCompositor => {
        const current = bindings.compositor();
        if (!current) throw new Error('The compositor is unavailable');
        return current;
    };
    function drawTexturedQuad(pass: GpuPass, texture: TextureHandle, source: Readonly<Rect>, dest: Readonly<Rect>, options: TexturedQuadOptions): void;
    function drawTexturedQuad(ctx: CanvasRenderingContext2D, image: ImageBitmap, source: Readonly<Rect>, dest: Readonly<Rect>, options: TexturedQuadOptions): void;
    function drawTexturedQuad(target: GpuPass | CanvasRenderingContext2D, image: TextureHandle | ImageBitmap,
        source: Readonly<Rect>, dest: Readonly<Rect>, options: TexturedQuadOptions): void {
        if ('drawImage' in target) compositor().resources.drawTexturedQuad(target, image as ImageBitmap, source, dest, options);
        else resources().drawTexturedQuad(target, image as TextureHandle, source, dest, options);
    }
    return {
        device: () => bindings.gpuResources()?.device ?? null,
        get generation() { return bindings.generation(); },
        allocator: bindings.allocator,
        invalidate: reason => bindings.invalidate(reason),
        wakeAt: deadline => bindings.wakeAt(deadline),
        paintWorld: (ctx: CanvasRenderingContext2D, view: ViewState, paint: () => void) => compositor().paintWorld(ctx, view, paint),
        paintPage: (ctx: CanvasRenderingContext2D, view: ViewState, index: number, paint: () => void) => compositor().paintPage(ctx, view, index, paint),
        uniforms: (bytes: ArrayBufferView): UniformSlice => resources().uniforms(bytes),
        drawTexturedQuad,
    };
}
