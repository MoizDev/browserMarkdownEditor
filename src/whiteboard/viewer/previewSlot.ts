import type { PlatformLayerDefinition } from '../../platform/render/attachPlatformPane.types';
import type { Layer } from '../../platform/render/types';
import type { ViewState } from '../../platform/types';

type EmptyReporter = { drewNothing(): boolean };

export interface PreviewSlot {
    readonly definition: PlatformLayerDefinition;
    set(next: PlatformLayerDefinition | null): void;
    dispose(): void;
}

const EMPTY_COVERAGE = Object.freeze({ complete: true, sharp: true });

export function createPreviewSlot(id: string, base: PlatformLayerDefinition): PreviewSlot {
    let target: PlatformLayerDefinition | null = null, epoch = 0;
    const instances = new Set<SlotLayer>();
    const MAX_KEYS = 4096;
    const keys = new Map<number, { epoch: number; revision: number }>();
    let lastKey = -1, lastEpoch = NaN, lastInner = NaN, lastDraw = NaN;
    const keyFor = (currentEpoch: number, innerRevision: number, draw: number): number => {
        if (currentEpoch === lastEpoch && innerRevision === lastInner && draw === lastDraw) return lastKey;
        lastEpoch = currentEpoch; lastInner = innerRevision; lastDraw = draw; lastKey = lastKey + 1;
        keys.set(lastKey, { epoch: currentEpoch, revision: innerRevision });
        if (keys.size > MAX_KEYS) for (const old of keys.keys()) { if (keys.size <= MAX_KEYS) break; keys.delete(old); }
        return lastKey;
    };
    class SlotLayer implements Layer {
        inner: Layer | null = null;
        innerDef: PlatformLayerDefinition | null = null;
        innerEpoch = 0;
        swapUnreported = false;
        constructor(private readonly host: Parameters<PlatformLayerDefinition['create']>[0]) {}
        sync(): Layer | null {
            if (this.innerEpoch === epoch) return this.inner;
            const old = this.inner;
            this.innerEpoch = epoch; this.swapUnreported = !!old && (old as Partial<EmptyReporter>).drewNothing?.() !== true;
            this.inner = null; this.innerDef = null;
            try { old?.dispose(); } finally {
                if (target) { this.inner = target.create(this.host); this.innerDef = target; }
            }
            return this.inner;
        }
        prepare(...args: Parameters<Layer['prepare']>): boolean | void {
            const inner = this.sync(), swapped = this.swapUnreported;
            this.swapUnreported = false;
            if (!inner) return swapped ? undefined : false;
            const answer = inner.prepare(...args);
            return swapped ? undefined : answer;
        }
        idle(): boolean { return this.innerEpoch === epoch && this.inner === null && !this.swapUnreported; }
        drawGpu(...args: Parameters<Layer['drawGpu']>) { this.sync()?.drawGpu(...args); }
        // Without this the compositor skips the preview's offscreen tiles entirely: nothing it composes is ever drawn.
        encodeOffscreen(...args: Parameters<NonNullable<Layer['encodeOffscreen']>>) { this.sync()?.encodeOffscreen?.(...args); }
        draw2d(...args: Parameters<Layer['draw2d']>) { this.sync()?.draw2d(...args); }
        releaseGpu(reason: Parameters<Layer['releaseGpu']>[0]) { this.inner?.releaseGpu(reason); }
        // No sync here: a sync would consume the epoch swap that prepare reports. On a swap frame the slot is single, its new inner
        // not existing yet, and two-phase from the next frame.
        get twoPhase(): true | undefined {
            return this.innerEpoch === epoch && this.inner?.twoPhase === true ? true : undefined;
        }
        get evictGpu(): Layer['evictGpu'] {
            const inner = this.inner;
            return inner?.evictGpu ? (bytes, frameId) => inner.evictGpu!(bytes, frameId) : undefined;
        }
        protectFrame(frameId: number, view: ViewState) { this.inner?.protectFrame?.(frameId, view); }
        memory() { return this.inner?.memory() ?? { gpuBytes: 0, cpuBytes: 0 }; }
        needsFrame() { return this.innerEpoch !== epoch || this.swapUnreported || (this.inner?.needsFrame() ?? false); }
        onFramePresented(revision: number, token: Parameters<NonNullable<Layer['onFramePresented']>>[1]) {
            const entry = keys.get(revision);
            if (!entry || entry.epoch !== epoch) return;
            for (const old of keys.keys()) { if (old > revision) break; keys.delete(old); }
            this.inner?.onFramePresented?.(entry.revision, token);
        }
        dispose() { instances.delete(this); const old = this.inner; this.inner = null; this.innerDef = null; old?.dispose(); }
    }
    const slot = (layer: Layer): SlotLayer => {
        if (!(layer instanceof SlotLayer)) throw new Error('Preview slot was handed a foreign layer');
        return layer;
    };
    const definition: PlatformLayerDefinition = {
        id, group: base.group, ...(base.isolation ? { isolation: base.isolation } : {}),
        create(host) { const layer = new SlotLayer(host); instances.add(layer); return layer; },
        revision(layer) {
            const s = slot(layer), inner = s.sync();
            const innerRevision = inner && s.innerDef ? s.innerDef.revision(inner) : 0;
            const draw = inner && s.innerDef?.drawVersion ? s.innerDef.drawVersion(inner) : 0;
            return keyFor(epoch, innerRevision, draw);
        },
        gpuWorkingSet(layer, viewport) {
            const s = slot(layer), inner = s.sync();
            return inner && s.innerDef?.gpuWorkingSet ? s.innerDef.gpuWorkingSet(inner, viewport) : { mandatoryBytes: 0 };
        },
        cpuEvict(layer, bytes) {
            const s = slot(layer), inner = s.sync();
            if (inner && s.innerDef?.cpuEvict) s.innerDef.cpuEvict(inner, bytes);
        },
        cpuWorkingSet(layer, viewport) {
            const s = slot(layer), inner = s.sync();
            return inner && s.innerDef?.cpuWorkingSet ? s.innerDef.cpuWorkingSet(inner, viewport) : { mandatoryBytes: 0, prefetchBytes: 0 };
        },
        critical(layer, view) { const s = slot(layer), inner = s.sync(); return !!inner && !!s.innerDef?.critical(inner, view); },
        coverage(layer, frame, backend) {
            const s = slot(layer), inner = s.sync();
            return inner && s.innerDef ? s.innerDef.coverage(inner, frame, backend) : EMPTY_COVERAGE;
        },
    };
    return {
        definition,
        set(next) { if (next === target) return; target = next; epoch++; keys.clear(); },
        dispose() { target = null; epoch++; keys.clear(); for (const layer of [...instances]) layer.dispose(); },
    };
}
