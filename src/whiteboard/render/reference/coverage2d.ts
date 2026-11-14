import type { PathCommand } from '../../../platform/types';
import { InkOutlineJob } from '../../ink/outline';
import type { InkCoverage } from '../../ink/outline';
import { inkCoverageChunks, type PaintInkCoverage } from '../paintStream';

export type PathOrigin2d = readonly [x: number, y: number];
const ZERO_ORIGIN: PathOrigin2d = Object.freeze([0, 0]);

/** Rebase in doubles before handing coordinates to the native path (rendering §2).
 * The caller composes this origin into its local-to-device transform exactly once.
 */
export function appendPath2d(path: Path2D, command: Readonly<PathCommand>, origin: PathOrigin2d = ZERO_ORIGIN): void {
    const [x, y] = origin;
    switch (command[0]) {
        case 'M':
            path.moveTo(command[1] - x, command[2] - y);
            break;
        case 'L':
            path.lineTo(command[1] - x, command[2] - y);
            break;
        case 'C':
            path.bezierCurveTo(command[1] - x, command[2] - y, command[3] - x, command[4] - y, command[5] - x, command[6] - y);
            break;
        case 'Z':
            path.closePath();
            break;
    }
}

export function path2d(commands: Iterable<Readonly<PathCommand>>, origin: PathOrigin2d = ZERO_ORIGIN): Path2D {
    const path = new Path2D();
    for (const command of commands) appendPath2d(path, command, origin);
    return path;
}

type WorkState = 'pending' | 'complete' | 'cancelled';

/** Clip and ordinary geometry can also be arbitrarily large; append one command per unit. */
export class Path2dJob {
    private path: Path2D | null = new Path2D();
    private commands: readonly PathCommand[] | null;
    private offset = 0;
    private state: WorkState = 'pending';
    readonly origin: PathOrigin2d;

    constructor(commands: readonly PathCommand[], origin: PathOrigin2d = ZERO_ORIGIN) {
        if (!origin.every(Number.isFinite)) throw new RangeError('Path origin must be finite');
        this.origin = Object.freeze([origin[0], origin[1]] as const);
        this.commands = commands;
    }

    get result(): Path2D | null { return this.state === 'complete' ? this.path : null; }
    get commandCount(): number { return this.offset; }

    step(maxWork: number): WorkState {
        if (this.state !== 'pending') return this.state;
        if (!Number.isSafeInteger(maxWork) || maxWork <= 0) throw new RangeError('Invalid path work slice');
        try {
            const commands = this.commands!;
            const end = Math.min(commands.length, this.offset + maxWork);
            while (this.offset < end) appendPath2d(this.path!, commands[this.offset++], this.origin);
            if (this.offset === commands.length) { this.commands = null; this.state = 'complete'; }
            return this.state;
        } catch (error) {
            this.cancel();
            throw error;
        }
    }

    cancel(): void {
        this.state = 'cancelled';
        this.commands = null;
        this.path = null;
    }
}

/** A partially appended path must never replace the previous complete stroke (rendering §2/§11).
 * The shared outline job counts cap refinement and empty primitives too, not just emitted commands.
 */
export class InkPath2dJob {
    private outline: InkOutlineJob | null;
    private path: Path2D | null = new Path2D();
    private state: WorkState = 'pending';
    private count = 0;
    readonly origin: PathOrigin2d;

    constructor(coverage: InkCoverage, deviceScale: number, origin: PathOrigin2d = ZERO_ORIGIN, maxCommands = 1048576) {
        if (!origin.every(Number.isFinite)) throw new RangeError('Ink path origin must be finite');
        this.origin = Object.freeze([origin[0], origin[1]] as const);
        const path = this.path!, localOrigin = this.origin;
        this.outline = new InkOutlineJob(coverage, deviceScale, command => appendPath2d(path, command, localOrigin), maxCommands);
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

/** Every chunk appends to one nonzero path; the stroke is filled once per band. */
export class InkCoverageUnionPath2dJob {
    private chunks: readonly InkCoverage[] | null;
    private path: Path2D | null = new Path2D();
    private outline: InkOutlineJob | null = null;
    private index = 0;
    private count = 0;
    private state: WorkState = 'pending';
    readonly origin: PathOrigin2d;
    constructor(coverage: PaintInkCoverage, private readonly deviceScale: number, private readonly maxCommands = 1048576) {
        if (!Number.isFinite(deviceScale) || deviceScale <= 0 || !Number.isSafeInteger(maxCommands) || maxCommands <= 0) {
            throw new RangeError('Invalid ink union path budget');
        }
        this.chunks = inkCoverageChunks(coverage);
        const first = this.chunks[0];
        const origin = first ? [first.boundsLocal.x, first.boundsLocal.y] as const : ZERO_ORIGIN;
        if (!origin.every(Number.isFinite)) throw new RangeError('Ink path origin must be finite');
        this.origin = Object.freeze([origin[0], origin[1]] as const);
    }
    get result(): Path2D | null { return this.state === 'complete' ? this.path : null; }
    get commandCount(): number { return this.count; }
    step(maxWork: number): WorkState {
        if (this.state !== 'pending') return this.state;
        if (!Number.isSafeInteger(maxWork) || maxWork <= 0) throw new RangeError('Invalid ink union work slice');
        try {
            for (let work = 0; work < maxWork; work++) {
                if (!this.outline) {
                    if (this.index === this.chunks!.length) { this.chunks = null; this.state = 'complete'; return this.state; }
                    this.outline = new InkOutlineJob(this.chunks![this.index++], this.deviceScale, command => {
                        if (this.count >= this.maxCommands) throw new RangeError('Ink union exceeds its finite command budget');
                        appendPath2d(this.path!, command, this.origin); this.count++;
                    }, this.maxCommands);
                }
                const status = this.outline.step(1);
                if (status === 'cancelled') { this.cancel(); return this.state; }
                if (status === 'complete') this.outline = null;
            }
            return this.state;
        } catch (error) { this.cancel(); throw error; }
    }
    cancel(): void {
        this.state = 'cancelled'; this.outline?.cancel(); this.outline = null; this.path = null; this.chunks = null;
    }
}

/** Cache by geometryKey + scale band and fill ONCE with nonzero, never capsule source-over.
 * Synchronous callers use this convenience entry; Layer.prepare advances InkPath2dJob instead.
 */
export function inkPath2d(coverage: InkCoverage, deviceScale: number, origin: PathOrigin2d = ZERO_ORIGIN, maxCommands = 1048576): Path2D {
    const job = new InkPath2dJob(coverage, deviceScale, origin, maxCommands);
    while (job.step(4096) === 'pending') { /* Bounded callers deliberately finish synchronously. */ }
    const result = job.result;
    if (!result) throw new Error('Ink path construction was cancelled');
    return result;
}
