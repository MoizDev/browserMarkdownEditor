import type { ViewState } from '../../platform/types';
import type { PlatformLayerDefinition } from '../../platform/render/attachPlatformPane.types';
import type { LayerHost } from '../../platform/render/compositor.types';
import type { ByteLease } from '../../platform/render/gfx/api';
import type { FrameBudget, GpuReleaseReason, Layer, RenderToken } from '../../platform/render/types';
import type { PaintFrameAssembler } from './frameTypes';
import type { PaintBand } from './material';
import { inkCoverageChunks, type PaintFrame, type PaintItem } from './paintStream';
import type { PaintImageProvider } from './resources';
import { createCanvasPaintAdapter, type CanvasPaintAdapter } from './reference/canvasPaintAdapter';

/** Until a real GPU executor exists the pane must select its Canvas2D backend. */
export const BOARD_BACKEND_PREFERENCE = 'canvas2d' as const;
export interface BoardLayersOptions {
    readonly frames: PaintFrameAssembler;
    readonly images: PaintImageProvider;
    readonly onError: (error: unknown) => void;
    readonly requestedRevision: () => number;
    readonly beforePrepare?: (view: ViewState, budget: FrameBudget) => void;
    readonly onPresented?: (revision: number, token: RenderToken) => void;
}
interface Estimate {
    readonly frame: PaintFrame;
    band: 0 | 1;
    index: number;
    clip: number;
    chunk: number;
    arc: number;
    bytes: number;
    done: boolean;
}
function sameToken(a: RenderToken, b: RenderToken): boolean {
    return a.vaultEpoch === b.vaultEpoch && a.documentId === b.documentId
        && a.bytesGeneration === b.bytesGeneration && a.session === b.session;
}
function addBytes(state: Estimate, bytes: number): void {
    const next = state.bytes + bytes;
    if (!Number.isSafeInteger(next) || next < 0) throw new RangeError('Board paint working set exceeds safe accounting');
    state.bytes = next;
}
/** One estimate unit visits one item, clip, or ink chunk; no whole-frame scan in demand(). */
function estimateStep(state: Estimate): void {
    const items = state.band === 0 ? state.frame.underlay : state.frame.content;
    if (state.index >= items.length) {
        if (state.band === 0) { state.band = 1; state.index = 0; }
        else state.done = true;
        return;
    }
    const item: PaintItem = items[state.index];
    if (state.clip < item.clips.length) {
        addBytes(state, item.clips[state.clip++].d.length * 80);
        return;
    }
    if (item.kind === 'ink') {
        const chunks = inkCoverageChunks(item.coverage);
        if (state.chunk < chunks.length) {
            const coverage = chunks[state.chunk], g = coverage.geometry;
            if (state.arc < 0) {
                const primitives = coverage.segments.length / 6 + coverage.discs.length / 3;
                // Conservative provisional path estimate; exact native Path2D allocation is opaque.
                addBytes(state, coverage.segments.byteLength + coverage.discs.byteLength + coverage.centreline.byteLength
                    + coverage.radii.byteLength + g.cubics.byteLength + g.flags.byteLength + primitives * 40 * 80);
                state.arc = 0; return;
            }
            if (state.arc < coverage.arcMaps.length) {
                const map = coverage.arcMaps[state.arc++];
                addBytes(state, map.cubic.byteLength + map.pieces.byteLength); return;
            }
            state.chunk++; state.arc = -1; return;
        }
    } else if (item.kind === 'path') addBytes(state, item.d.length * 80);
    state.index++; state.clip = 0; state.chunk = 0; state.arc = -1;
}

/** Each invocation belongs to one view; the paired layer definitions share one adapter. */
export function createBoardLayers(options: BoardLayersOptions): readonly [PlatformLayerDefinition, PlatformLayerDefinition] & { invalidate(reason?: string): void } {
    const hosts = new Map<PaintBand, LayerHost>();
    let adapter: CanvasPaintAdapter | null = null, allocatorHost: LayerHost | null = null;
    let estimate: Estimate | null = null, denied = false, disposed = false, lastPrepareFrame: number | null = null;
    let presented: PaintFrame | null = null, ackFrame: PaintFrame | null = null, ackMask = 0;
    const drawn = new Map<PaintBand, PaintFrame>();
    const reservations = new Map<PaintFrame, ByteLease[]>(), known = new Set<PaintFrame>();
    let reserved = 0;
    const activeHost = () => hosts.get('underlay') ?? hosts.get('content');
    const report = (error: unknown) => { try { options.onError(error); } catch { /* reporting cannot reject a worker callback */ } };
    const releaseFrame = (frame: PaintFrame) => {
        const leases = reservations.get(frame);
        if (!leases) return;
        reservations.delete(frame);
        for (const lease of leases) { allocatorHost!.allocator.cpu.release(lease); reserved -= lease.bytes; }
    };
    const clearResources = (reason: GpuReleaseReason) => {
        // The reference adapter keeps CPU paths on context loss; this owner must
        // explicitly evict them before returning its CPU leases for any release.
        adapter?.release(reason === 'context-lost' ? 'pressure' : reason);
        for (const frame of [...reservations.keys()]) releaseFrame(frame);
        estimate = null; denied = false; lastPrepareFrame = null; drawn.clear(); ackFrame = null; ackMask = 0;
        if (reason === 'hidden') { options.frames.clear(); known.clear(); presented = null; }
    };
    const ensureAdapter = (host: LayerHost): CanvasPaintAdapter => {
        if (!adapter) {
            allocatorHost = host;
            adapter = createCanvasPaintAdapter({ frames: options.frames, images: options.images,
                invalidate: () => activeHost()?.invalidate('board-resource') },
            (ctx, view, paint) => { const owner = activeHost(); if (!owner) throw new Error('Board layer is detached'); owner.paintWorld(ctx, view, paint); }, report);
        }
        return adapter;
    };
    const startEstimate = (frame: PaintFrame) => {
        if (estimate?.frame === frame) return;
        known.add(frame);
        estimate = { frame, band: 0, index: 0, clip: 0, chunk: 0, arc: -1, bytes: 0, done: false }; denied = false;
    };
    const prune = (requested: PaintFrame, ready: PaintFrame | null) => {
        for (const frame of known) {
            if (frame !== requested && frame !== ready && frame !== presented && frame !== drawn.get('underlay') && frame !== drawn.get('content')) {
                options.frames.retire(frame); releaseFrame(frame); known.delete(frame);
            }
        }
    };
    const prepare = (view: ViewState, budget: FrameBudget) => {
        if (!adapter || disposed || lastPrepareFrame === budget.frameId) return;
        lastPrepareFrame = budget.frameId;
        try {
            options.beforePrepare?.(view, budget);
            options.frames.prepare(budget);
            const frame = options.frames.readFrame();
            if (!frame || !options.frames.isCurrent(frame) || !sameToken(frame.token, budget.token)) return;
            startEstimate(frame);
            while (!estimate!.done && !budget.shouldYield()) estimateStep(estimate!);
            if (!estimate!.done) return;
            if (!reservations.has(frame)) {
                const bytes = estimate!.bytes;
                if (bytes) {
                    const lease = allocatorHost!.allocator.cpu.reserve(bytes);
                    if (!lease) { denied = true; return; }
                    reservations.set(frame, [lease]); reserved += lease.bytes;
                } else reservations.set(frame, []);
            }
            denied = false;
            adapter.prepare(view, budget);
            prune(frame, adapter.readyFrame());
        } catch (error) { report(error); }
    };
    const acknowledge = (band: PaintBand, revision: number, token: RenderToken) => {
        const frame = drawn.get(band);
        if (!frame || frame.sceneRevision !== revision || !sameToken(frame.token, token)) return;
        if (ackFrame !== frame) { ackFrame = frame; ackMask = 0; }
        ackMask |= band === 'underlay' ? 1 : 2;
        if (ackMask !== 3) return;
        if (presented === frame) { ackFrame = null; ackMask = 0; return; }
        try {
            options.frames.presented(frame);
            const previous = presented; presented = frame; ackFrame = null; ackMask = 0;
            if (previous && previous !== frame) { options.frames.retire(previous); releaseFrame(previous); known.delete(previous); }
            options.onPresented?.(revision, token);
        } catch (error) { report(error); }
    };
    const definition = (band: PaintBand): PlatformLayerDefinition => ({
        id: `board-${band}`, group: 'document',
        create(host) {
            if (disposed || hosts.has(band)) throw new Error('Board layer already attached');
            hosts.set(band, host); ensureAdapter(host);
            let ended = false;
            const layer: Layer = {
                prepare,
                drawGpu() { throw new Error('Board layer is Canvas2D-only; select the canvas2d backend'); },
                draw2d(ctx, view) {
                    const frame = adapter?.readyFrame();
                    if (!frame) return;
                    drawn.set(band, frame);
                    adapter!.draw2d(ctx, view, band);
                },
                releaseGpu(reason) { clearResources(reason); },
                memory() { return { gpuBytes: 0, cpuBytes: allocatorHost === host ? reserved : 0 }; },
                needsFrame() {
                    return !disposed && !ended && (options.frames.needsFrame() || (!denied && (!!estimate && !estimate.done || !!adapter?.needsFrame())));
                },
                onFramePresented(revision, token) { acknowledge(band, revision, token); },
                dispose() {
                    if (ended) return;
                    ended = true;
                    if (allocatorHost === host) { clearResources('pressure'); allocatorHost = null; }
                    hosts.delete(band);
                    if (!hosts.size) {
                        disposed = true; adapter?.dispose(); adapter = null;
                        options.frames.clear(); known.clear(); presented = null;
                    } else if (!allocatorHost) allocatorHost = activeHost()!;
                },
            };
            return layer;
        },
        revision() { return options.requestedRevision(); },
        cpuWorkingSet() { return { mandatoryBytes: hosts.get(band) === allocatorHost ? reserved + (estimate && !reservations.has(estimate.frame) ? estimate.bytes : 0) : 0, prefetchBytes: 0 }; },
        critical() { return !adapter?.readyFrame(); },
        coverage(layer, frame) {
            const ready = adapter?.readyFrame(), requested = frame.layers.find(item => item.layer === layer)?.sceneRevision;
            if (!ready || !sameToken(ready.token, frame.token)) return { complete: false, sharp: false };
            const current = ready.sceneRevision === requested && ready.sceneRevision === options.requestedRevision() && options.frames.isCurrent(ready);
            return current ? { complete: true, sharp: true } : { complete: false, sharp: false, staleVersion: true };
        },
    });
    const pair = [definition('underlay'), definition('content')] as unknown as [PlatformLayerDefinition, PlatformLayerDefinition] & { invalidate(reason?: string): void };
    pair.invalidate = (reason = 'board-content') => { for (const host of hosts.values()) host.invalidate(reason); };
    return Object.freeze(pair);
}
