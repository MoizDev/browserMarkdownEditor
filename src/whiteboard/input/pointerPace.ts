import type { RealSample } from './tool';

/** The pointer's speed over its last movement, CSS px per ms, measured on every raw sample. Measuring on previews would
 * average a whole stroke (a preview skips the samples between renders), so a fast final flick would read as slow. A sample
 * that repeats the last time keeps the speed of the movement before it, so a release is judged by the movement that led to it. */
export class PointerPace {
    private last: RealSample | undefined;
    private value = 0;
    constructor(start?: RealSample) { this.last = start; }
    observe(samples: readonly RealSample[]): void {
        for (const sample of samples) {
            const last = this.last;
            // A sample that did not move (the release at the last point) says nothing about speed: the gate must judge a drop by
            // the movement the preview already showed, or a fast flick would snap on release while its preview did not.
            if (last && sample.time > last.time) {
                const moved = Math.hypot((sample.surfaceX ?? sample.x) - (last.surfaceX ?? last.x), (sample.surfaceY ?? sample.y) - (last.surfaceY ?? last.y));
                if (moved > 0) this.value = moved / (sample.time - last.time);
            }
            this.last = sample;
        }
    }
    speed(): number { return this.value; }
}
