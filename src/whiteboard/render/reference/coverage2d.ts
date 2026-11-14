import type { PathCommand } from '../../../platform/types';
import { InkOutlineJob } from '../../ink/outline';
import type { InkCoverage } from '../../ink/outline';

/** Append absolute C2 path commands without invoking the browser's SVG parser. */
export function appendPath2d(path: Path2D, command: Readonly<PathCommand>): void {
    switch (command[0]) {
        case 'M':
            path.moveTo(command[1], command[2]);
            break;
        case 'L':
            path.lineTo(command[1], command[2]);
            break;
        case 'C':
            path.bezierCurveTo(command[1], command[2], command[3], command[4], command[5], command[6]);
            break;
        case 'Z':
            path.closePath();
            break;
    }
}

export function path2d(commands: Iterable<Readonly<PathCommand>>): Path2D {
    const path = new Path2D();
    for (const command of commands) appendPath2d(path, command);
    return path;
}

type WorkState = 'pending' | 'complete' | 'cancelled';

/** A partially appended path must never replace the previous complete stroke (rendering §2/§11).
 * The shared outline job counts cap refinement and empty primitives too, not just emitted commands.
 */
export class InkPath2dJob {
    private outline: InkOutlineJob | null;
    private path: Path2D | null = new Path2D();
    private state: WorkState = 'pending';
    private count = 0;

    constructor(coverage: InkCoverage, deviceScale: number) {
        const path = this.path!;
        this.outline = new InkOutlineJob(coverage, deviceScale, command => appendPath2d(path, command));
    }

    get result(): Path2D | null { return this.state === 'complete' ? this.path : null; }
    get commandCount(): number { return this.count; }

    step(maxWork: number): WorkState {
        if (this.state !== 'pending') return this.state;
        const outline = this.outline!;
        try {
            this.state = outline.step(maxWork);
            this.count = outline.commandCount;
        } catch (error) {
            this.cancel();
            throw error;
        }
        if (this.state !== 'pending') {
            this.outline = null;
            if (this.state === 'cancelled') this.path = null;
        }
        return this.state;
    }

    cancel(): void {
        this.state = 'cancelled';
        this.path = null;
        const outline = this.outline;
        this.outline = null;
        outline?.cancel();
    }
}

/** Cache by geometryKey + scale band and fill ONCE with nonzero, never capsule source-over.
 * Synchronous callers use this convenience entry; Layer.prepare advances InkPath2dJob instead.
 */
export function inkPath2d(coverage: InkCoverage, deviceScale: number): Path2D {
    const job = new InkPath2dJob(coverage, deviceScale);
    while (job.step(4096) === 'pending') { /* Bounded callers deliberately finish synchronously. */ }
    const result = job.result;
    if (!result) throw new Error('Ink path construction was cancelled');
    return result;
}
