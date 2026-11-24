import type { PlatformLayerDefinition } from '../../platform/render/attachPlatformPane.types';
import type { Layer } from '../../platform/render/types';
import type { ViewState } from '../../platform/types';

/** A board layer's report that its last draw laid nothing (boardLayers' `drewNothing`); absent on other layers. */
type EmptyReporter = { drewNothing(): boolean };

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
    // The revision the slot schedules by is a small key, one per distinct (epoch, inner revision, draw version): the
    // inner layer's own revision is what it acknowledges, and a draw version changes the picture without changing it.
    // A key of an earlier epoch is never acknowledged into a replaced preview.
    // A key lives until a later key is presented (frames present in key order, so that one supersedes it) or the preview is
    // swapped. Dropping the oldest key by count instead lost the acknowledgement of a frame still awaited when a stalled
    // compositor let 64 newer keys pile up during a drag; the overlay then never started its next request. The cap is only
    // a memory guard for a compositor that never presents at all.
    const MAX_KEYS = 4096;
    const keys = new Map<number, { epoch: number; revision: number }>();
    // The three numbers are compared as numbers: the scheduler asks for this key every frame, and a string built per call was
    // the only allocation in that path (by reading).
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
        // A swap (a new preview, or a clear) not yet reported by a prepare. The definition's revision, critical, coverage and working
        // set hooks sync too, and the scheduler reads them before it prepares: reported by the epoch alone, the swap was consumed
        // there, the prepare after a clear answered unchanged, and the cleared preview's last picture stayed on screen over the
        // board's (kinds rotate, WebGL2 DPR 2 dark: the rotated rectangle drawn twice, by the board and the stale preview, for good).
        swapUnreported = false;
        constructor(private readonly host: Parameters<PlatformLayerDefinition['create']>[0]) {}
        sync(): Layer | null {
            if (this.innerEpoch === epoch) return this.inner;
            const old = this.inner;
            // A replaced layer whose last draw laid nothing leaves the picture as it was: a drag's overlay once its commit is drawn by
            // the board (its nodes then omitted from it). Reported, its clear presented the same picture again (round 9 info timing,
            // drawing and large drag: the drag's last present, adapter-release:board-preview, the preview layers alone changed).
            this.innerEpoch = epoch; this.swapUnreported = !!old && (old as Partial<EmptyReporter>).drewNothing?.() !== true;
            this.inner = null; this.innerDef = null;
            try { old?.dispose(); } finally {
                if (target) { this.inner = target.create(this.host); this.innerDef = target; }
            }
            return this.inner;
        }
        // The frame that swaps the slot's layer, or clears it, changed what is drawn: the answer says nothing about a picture that
        // was presented from the replaced layer, so that frame reports changed. Once cleared, the slot draws nothing, and a frame
        // that finds nothing to draw leaves nothing that differs from the cleared picture, so it reports unchanged.
        prepare(...args: Parameters<Layer['prepare']>): boolean | void {
            const inner = this.sync(), swapped = this.swapUnreported;
            this.swapUnreported = false;
            if (!inner) return swapped ? undefined : false;
            const answer = inner.prepare(...args);
            return swapped ? undefined : answer;
        }
        // A cleared slot draws nothing: nothing it shows moves with the camera.
        idle(): boolean { return this.innerEpoch === epoch && this.inner === null && !this.swapUnreported; }
        drawGpu(...args: Parameters<Layer['drawGpu']>) { this.sync()?.drawGpu(...args); }
        // Without this the compositor skips the preview's offscreen tiles entirely: nothing it composes is ever drawn.
        encodeOffscreen(...args: Parameters<NonNullable<Layer['encodeOffscreen']>>) { this.sync()?.encodeOffscreen?.(...args); }
        draw2d(...args: Parameters<Layer['draw2d']>) { this.sync()?.draw2d(...args); }
        releaseGpu(reason: Parameters<Layer['releaseGpu']>[0]) { this.inner?.releaseGpu(reason); }
        // The scheduler reads the flag on the object it prepares, which is this slot: without it the preview's overlay never gets the
        // foreground pass and its admissions are refused on the single window (measured: board-preview:live:dropped:deferred:single 10).
        // No sync here: a sync would consume the epoch swap that prepare reports. On a swap frame the slot is single, its new inner
        // not existing yet, and two-phase from the next frame.
        get twoPhase(): true | undefined {
            return this.innerEpoch === epoch && this.inner?.twoPhase === true ? true : undefined;
        }
        // Present only when the inner layer partially evicts: the platform releases a layer without this hook whole, and a slot
        // that always had one would never be released whole, even when its inner layer has no partial release to offer.
        get evictGpu(): Layer['evictGpu'] {
            const inner = this.inner;
            return inner?.evictGpu ? (bytes, frameId) => inner.evictGpu!(bytes, frameId) : undefined;
        }
        protectFrame(frameId: number, view: ViewState) { this.inner?.protectFrame?.(frameId, view); }
        memory() { return this.inner?.memory() ?? { gpuBytes: 0, cpuBytes: 0 }; }
        needsFrame() { return this.innerEpoch !== epoch || this.swapUnreported || (this.inner?.needsFrame() ?? false); }
        // The revision the slot reports carries its epoch; the inner layer acknowledges the revision it reported itself.
        // Forwarding the packed value never matched (measured: acknowledged 4294967299 against a revision of 3), so no
        // overlay presentation completed. An acknowledgement from an earlier epoch belongs to the replaced preview.
        onFramePresented(revision: number, token: Parameters<NonNullable<Layer['onFramePresented']>>[1]) {
            const entry = keys.get(revision);
            if (!entry || entry.epoch !== epoch) return;
            // Keys are created in ascending order and presented in that order: every key up to this one is done.
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
        // The epoch keeps a swapped-in preview from reusing the revision its predecessor reported.
        revision(layer) {
            const s = slot(layer), inner = s.sync();
            const innerRevision = inner && s.innerDef ? s.innerDef.revision(inner) : 0;
            const draw = inner && s.innerDef?.drawVersion ? s.innerDef.drawVersion(inner) : 0;
            return keyFor(epoch, innerRevision, draw);
        },
        // The platform pins a layer's GPU working set and evicts its CPU bytes through the definition: a slot without these would
        // drop the live preview's share from both, for as long as the preview is up.
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
        // A replaced epoch's keys can never be acknowledged, so they go now rather than at the cap.
        set(next) { if (next === target) return; target = next; epoch++; keys.clear(); },
        dispose() { target = null; epoch++; keys.clear(); for (const layer of [...instances]) layer.dispose(); },
    };
}
