import type { RealSample } from './tool';

export class PointerPace {
    private last: RealSample | undefined;
    private value = 0;
    constructor(start?: RealSample) { this.last = start; }
    observe(samples: readonly RealSample[]): void {
        for (const sample of samples) {
            const last = this.last;
            if (last && sample.time > last.time) {
                const moved = Math.hypot((sample.surfaceX ?? sample.x) - (last.surfaceX ?? last.x), (sample.surfaceY ?? sample.y) - (last.surfaceY ?? last.y));
                if (moved > 0) this.value = moved / (sample.time - last.time);
            }
            this.last = sample;
        }
    }
    speed(): number { return this.value; }
}
