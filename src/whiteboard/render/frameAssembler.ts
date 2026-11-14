import type { FrameBudget } from '../../platform/render/types';
import { PaintStreamJob } from './paintStream';
import type { PaintFrame, PaintItem } from './paintStream';
import type { PaintFrameAssembler, PinnedPaintSource } from './frameTypes';

interface Staging {
    readonly pin: PinnedPaintSource;
    readonly job: PaintStreamJob;
    readonly underlay: PaintItem[];
    readonly content: PaintItem[];
}
interface Published { readonly pin: PinnedPaintSource; readonly frame: PaintFrame }

/** Stages source commands in bounded slices. A retired frame's source lease remains owned until
 * the backend explicitly drops it; a newer requested revision alone never frees pixels in use. */
export function createPaintFrameAssembler(invalidate: () => void, onError: (error: unknown) => void): PaintFrameAssembler {
    let staging: Staging | null = null, latest: Published | null = null, disposed = false;
    const retained = new Map<PaintFrame, Published>();
    const dropStaging = () => {
        if (!staging) return;
        staging.job.cancel(); staging.pin.release(); staging = null;
    };
    const retire = (frame: PaintFrame) => {
        const entry = retained.get(frame);
        if (!entry || entry === latest) return;
        retained.delete(frame); entry.pin.release();
    };
    return {
        request(pin) {
            if (disposed) { pin.release(); return; }
            dropStaging();
            const underlay: PaintItem[] = [], content: PaintItem[] = [];
            const job = new PaintStreamJob(pin.source, (item, band) => (band === 'underlay' ? underlay : content).push(item));
            staging = { pin, job, underlay, content };
            invalidate();
        },
        prepare(budget) {
            const work = staging;
            if (disposed || !work) return;
            try {
                while (!budget.shouldYield()) {
                    const status = work.job.step(1);
                    if (status === 'pending') continue;
                    if (status !== 'complete') { dropStaging(); return; }
                    const frame: PaintFrame = Object.freeze({ token: work.pin.source.token, sceneRevision: work.pin.source.sceneRevision,
                        underlay: Object.freeze(work.underlay), content: Object.freeze(work.content) });
                    const published: Published = { pin: work.pin, frame };
                    retained.set(frame, published); latest = published; staging = null; invalidate(); return;
                }
            } catch (error) { dropStaging(); onError(error); }
        },
        readFrame: () => disposed ? null : latest?.frame ?? null,
        isCurrent: frame => !disposed && retained.has(frame) && retained.get(frame)!.pin.source.isCurrent(),
        needsFrame: () => !disposed && staging !== null,
        presented(frame) {
            if (!retained.has(frame)) throw new Error('Cannot present an unowned paint frame');
        },
        retire,
        dispose() {
            if (disposed) return;
            disposed = true; dropStaging(); latest = null;
            for (const entry of retained.values()) entry.pin.release();
            retained.clear();
        },
    };
}
