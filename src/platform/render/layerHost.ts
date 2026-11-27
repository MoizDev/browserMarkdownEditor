import type { Rect, ViewState } from '../types';
import type { DamageRecord } from './damage';
import type { CompositorResources, LayerAllocators, LayerHost, PaneCompositor, TexturedQuadOptions, TexturedQuadSpec } from './compositor.types';
import type { LayerTrouble } from './types';
import type { DrawableImage, GpuPass, TextureHandle, UniformSlice } from './gfx/api';
import { paintCanvasIsolation } from './canvas2dContext';
import { auditCount, auditStage, registerAuditView, renderAuditEnabled } from './renderAudit';
import type { GfxDevice } from './gfx/api';

export interface LayerHostBindings {
    readonly allocator: LayerAllocators;
    readonly auditId?: string;
    generation(): number;
    gpuResources(): CompositorResources | null;
    compositor(): PaneCompositor | null;
    preparationCompositor(): PaneCompositor | null;
    invalidate(reason: string, damage?: DamageRecord): void;
    wakeAt(deadlineMs: number | null): void;
    demandChanged?(): void;
    refreshDemandNow?(): void;
    trouble?(): LayerTrouble;
    gpuError?(error: unknown): void;
}

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
    const surface = bindings.auditId ?? 'layer';
    function drawTexturedQuad(pass: GpuPass, texture: TextureHandle, source: Readonly<Rect>, dest: Readonly<Rect>, options: TexturedQuadOptions): void;
    function drawTexturedQuad(ctx: CanvasRenderingContext2D, image: DrawableImage, source: Readonly<Rect>, dest: Readonly<Rect>, options: TexturedQuadOptions): void;
    function drawTexturedQuad(target: GpuPass | CanvasRenderingContext2D, image: TextureHandle | DrawableImage,
        source: Readonly<Rect>, dest: Readonly<Rect>, options: TexturedQuadOptions): void {
        if ('drawImage' in target) { auditCount(surface, 'canvas2d-quad'); compositor().resources.drawTexturedQuad(target, image as DrawableImage, source, dest, options); }
        else { auditCount(surface, 'gpu-quad'); resources().drawTexturedQuad(target, image as TextureHandle, source, dest, options); }
    }
    function drawTexturedQuads(pass: GpuPass, texture: TextureHandle, quads: readonly TexturedQuadSpec[], options: TexturedQuadOptions): void;
    function drawTexturedQuads(ctx: CanvasRenderingContext2D, image: DrawableImage, quads: readonly TexturedQuadSpec[], options: TexturedQuadOptions): void;
    function drawTexturedQuads(target: GpuPass | CanvasRenderingContext2D, image: TextureHandle | DrawableImage,
        quads: readonly TexturedQuadSpec[], options: TexturedQuadOptions): void {
        if ('drawImage' in target) { auditCount(surface, 'canvas2d-quad', quads.length); compositor().resources.drawTexturedQuads(target, image as DrawableImage, quads, options); }
        else { auditCount(surface, 'gpu-quad-batch', 1, { quads: quads.length }); resources().drawTexturedQuads(target, image as TextureHandle, quads, options); }
    }
    const audited = new WeakMap<GfxDevice, GfxDevice>();
    const auditedDevice = (device: GfxDevice | null): GfxDevice | null => {
        if (!device || !renderAuditEnabled()) return device;
        let view = audited.get(device);
        if (!view) {
            view = new Proxy(device, { get(target, key) {
                const value = Reflect.get(target, key, target) as unknown;
                if (typeof value !== 'function') return value;
                if (key === 'writeTexture') return (dst: unknown, rect: Rect, src: unknown) => {
                    auditCount(surface, 'upload', 1, { bytes: rect.width * rect.height * 4 });
                    const started = performance.now();
                    try { return (value as (...args: unknown[]) => unknown).call(target, dst, rect, src); }
                    finally { auditStage(surface, 'upload', performance.now() - started); }
                };
                if (key === 'writeBuffer') return (dst: unknown, offset: number, src: ArrayBufferView) => {
                    auditCount(surface, 'upload', 1, { bytes: src.byteLength });
                    const started = performance.now();
                    try { return (value as (...args: unknown[]) => unknown).call(target, dst, offset, src); }
                    finally { auditStage(surface, 'upload', performance.now() - started); }
                };
                if (key === 'createTexture' || key === 'createBuffer' || key === 'createCoverageTarget') {
                    return (...args: unknown[]) => { auditCount(surface, String(key)); return (value as (...a: unknown[]) => unknown).apply(target, args); };
                }
                return (value as (...args: unknown[]) => unknown).bind(target);
            } }) as GfxDevice;
            audited.set(device, view); registerAuditView(view, device);
        }
        return view;
    };
    return {
        device: () => auditedDevice(bindings.gpuResources()?.device ?? null),
        reportGpuError: (error: unknown) => bindings.gpuError?.(error),
        get generation() { return bindings.generation(); },
        allocator: bindings.allocator,
        reserveIsolation: reservation => {
            const preparing = bindings.preparationCompositor();
            if (!preparing) throw new Error('The preparing compositor is unavailable');
            preparing.resources.reserveIsolation(reservation);
        },
        paintIsolation: paintCanvasIsolation,
        invalidate: (reason, damage) => bindings.invalidate(reason, damage),
        wakeAt: deadline => bindings.wakeAt(deadline),
        demandChanged: () => bindings.demandChanged?.(),
        refreshDemandNow: () => bindings.refreshDemandNow?.(),
        paintWorld: (ctx: CanvasRenderingContext2D, view: ViewState, paint: () => void) => { auditCount(surface, 'canvas2d'); compositor().paintWorld(ctx, view, paint); },
        paintPage: (ctx: CanvasRenderingContext2D, view: ViewState, index: number, paint: () => void) => { auditCount(surface, 'canvas2d'); compositor().paintPage(ctx, view, index, paint); },
        paneTransform: (view, frameId) => bindings.compositor()?.paneTransform(view, frameId) ?? null,
        uniforms: (bytes: ArrayBufferView): UniformSlice => resources().uniforms(bytes),
        markIncomplete: (reason: string): void => bindings.gpuResources()?.markIncomplete(reason),
        uniformsInto: (bytes: ArrayBufferView, into: UniformSlice): void => resources().uniformsInto(bytes, into),
        drawTexturedQuad,
        drawTexturedQuads,
        imageReady: image => bindings.compositor()?.resources.imageReady?.(image) ?? true,
        trouble: () => bindings.trouble?.() ?? 'none',
    };
}
