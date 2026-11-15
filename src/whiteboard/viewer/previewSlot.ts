import type { PlatformLayerDefinition } from '../../platform/render/attachPlatformPane.types';
import type { Layer } from '../../platform/render/types';

/**
 * A permanent place in the pane's layer topology for the live creation preview.
 *
 * Inserting the preview's own layers when a preview appeared changed the topology mid-gesture,
 * and a new topology seals platform input: the seal detached input and cancelled the very
 * Rectangle/Arrow/Note gesture that asked for the preview, so nothing ever committed (measured:
 * every creation gesture cancelled 'invalidated' from PaneLifecycle.setLayers → seal). The slot
 * stays in the list for the view's life and forwards to whichever preview layer is current,
 * creating it on the same host and disposing the old one when the preview changes.
 */
export interface PreviewSlot {
    readonly definition: PlatformLayerDefinition;
    /** Point the slot at a new preview definition (or none); instances swap on their next call. */
    set(next: PlatformLayerDefinition | null): void;
    dispose(): void;
}

const EMPTY_COVERAGE = Object.freeze({ complete: true, sharp: true });

export function createPreviewSlot(id: string, base: PlatformLayerDefinition): PreviewSlot {
    let target: PlatformLayerDefinition | null = null, epoch = 0;
    const instances = new Set<SlotLayer>();
    class SlotLayer implements Layer {
        inner: Layer | null = null;
        innerDef: PlatformLayerDefinition | null = null;
        innerEpoch = 0;
        constructor(private readonly host: Parameters<PlatformLayerDefinition['create']>[0]) {}
        sync(): Layer | null {
            if (this.innerEpoch === epoch) return this.inner;
            const old = this.inner;
            this.inner = null; this.innerDef = null; this.innerEpoch = epoch;
            try { old?.dispose(); } finally {
                if (target) { this.inner = target.create(this.host); this.innerDef = target; }
            }
            return this.inner;
        }
        prepare(...args: Parameters<Layer['prepare']>) { this.sync()?.prepare(...args); }
        drawGpu(...args: Parameters<Layer['drawGpu']>) { this.sync()?.drawGpu(...args); }
        draw2d(...args: Parameters<Layer['draw2d']>) { this.sync()?.draw2d(...args); }
        releaseGpu(reason: Parameters<Layer['releaseGpu']>[0]) { this.inner?.releaseGpu(reason); }
        memory() { return this.inner?.memory() ?? { gpuBytes: 0, cpuBytes: 0 }; }
        needsFrame() { return this.innerEpoch !== epoch || (this.inner?.needsFrame() ?? false); }
        onFramePresented(...args: Parameters<NonNullable<Layer['onFramePresented']>>) { this.inner?.onFramePresented?.(...args); }
        dispose() { instances.delete(this); const old = this.inner; this.inner = null; this.innerDef = null; old?.dispose(); }
    }
    const slot = (layer: Layer): SlotLayer => {
        if (!(layer instanceof SlotLayer)) throw new Error('Preview slot was handed a foreign layer');
        return layer;
    };
    const definition: PlatformLayerDefinition = {
        id, group: base.group, ...(base.isolation ? { isolation: base.isolation } : {}),
        create(host) { const layer = new SlotLayer(host); instances.add(layer); return layer; },
        // The epoch keeps a swapped-in preview from reusing the revision its predecessor reported.
        revision(layer) { const s = slot(layer), inner = s.sync(); return epoch * 2 ** 32 + (inner && s.innerDef ? s.innerDef.revision(inner) : 0); },
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
        set(next) { if (next === target) return; target = next; epoch++; },
        dispose() { target = null; epoch++; for (const layer of [...instances]) layer.dispose(); },
    };
}
