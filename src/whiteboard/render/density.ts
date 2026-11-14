export type DensityMode = 'direct' | 'dense';
export interface DensityObservation {
    readonly frameId: number;
    readonly now: number;
    readonly candidateSegments: number;
    readonly coveredDevicePixels: number;
    readonly estimatedGpuMs: number;
}

/** Hysteresis advances only on real, consecutive observations, never on an idle timer. */
export class DensityController {
    private mode: DensityMode = 'direct';
    private frame: number | null = null;
    private time = -Infinity;
    private changedAt = -Infinity;
    private entering = 0;
    private leaving = 0;
    current(): DensityMode { return this.mode; }
    pending(): boolean { return this.entering > 0 || this.leaving > 0; }
    reset(): void {
        this.mode = 'direct'; this.frame = null; this.time = -Infinity; this.changedAt = -Infinity;
        this.entering = 0; this.leaving = 0;
    }
    observe(value: DensityObservation): DensityMode {
        const { frameId, now, candidateSegments, coveredDevicePixels, estimatedGpuMs } = value;
        if (!Number.isSafeInteger(frameId) || frameId < 0 || !Number.isFinite(now)
            || !Number.isFinite(candidateSegments) || candidateSegments < 0
            || !Number.isFinite(coveredDevicePixels) || coveredDevicePixels < 0
            || !Number.isFinite(estimatedGpuMs) || estimatedGpuMs < 0) throw new RangeError('Invalid density observation');
        if (this.frame !== null && frameId === this.frame) return this.mode;
        if (this.frame !== null && (frameId < this.frame || now < this.time)) throw new RangeError('Density observations must be ordered');
        if (this.frame !== null && frameId !== this.frame + 1) { this.entering = 0; this.leaving = 0; }
        this.frame = frameId; this.time = now;
        const density = candidateSegments / Math.max(1, coveredDevicePixels);
        if (this.mode === 'direct') {
            this.leaving = 0;
            this.entering = ((density >= 0.15 && estimatedGpuMs >= 4) || estimatedGpuMs >= 6) ? this.entering + 1 : 0;
            if (this.entering >= 3 && now - this.changedAt >= 200) {
                this.mode = 'dense'; this.changedAt = now; this.entering = 0;
            }
        } else {
            this.entering = 0;
            this.leaving = density <= 0.08 && estimatedGpuMs <= 2 ? this.leaving + 1 : 0;
            if (this.leaving >= 12 && now - this.changedAt >= 200) {
                this.mode = 'direct'; this.changedAt = now; this.leaving = 0;
            }
        }
        return this.mode;
    }
}
