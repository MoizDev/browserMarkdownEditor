import type { WorkerContext } from '../../platform/workers';
import { BoardFonts, type FontKey } from './fonts';
import { BoardTextLayout } from './layout';
import { ReferenceMeasurer } from './measure';
import { validLayoutRequest } from './layoutValidation';

let engine: BoardTextLayout | undefined;
let fonts: BoardFonts | undefined;
const active = new Set<WorkerContext>();
let lastContext: WorkerContext | undefined;
function notify(epoch: number, key: FontKey): void {
    let destination: WorkerContext | undefined;
    for (const context of active) if (!context.cancelled) destination = context;
    (destination ?? lastContext)?.emit('fontEpoch', { epoch, key });
}
function getEngine(): BoardTextLayout {
    if (engine) return engine;
    const canvas = new OffscreenCanvas(1, 1);
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Text layout needs an OffscreenCanvas 2D context');
    if (!fonts) {
        fonts = new BoardFonts((globalThis as unknown as { fonts: FontFaceSet }).fonts);
        fonts.subscribe(notify);
    }
    engine = new BoardTextLayout(new ReferenceMeasurer(context), fonts);
    return engine;
}
/** Handler for the shared parse worker; no text resources are allocated until first use. */
export async function layout(args: unknown, context: WorkerContext) {
    if (!validLayoutRequest(args)) throw new TypeError('Invalid board text layout request');
    context.signal.throwIfAborted();
    active.add(context); lastContext = context;
    try {
        await context.slice();
        const current = getEngine();
        await current.prepare(args);
        context.signal.throwIfAborted();
        await context.slice();
        const resolved = { ...args, fontEpoch: fonts!.epoch };
        const paint = current.layout(resolved);
        if (!paint.faceTable) throw new Error('Text paint has no owning face table');
        const measurement = current.measure(resolved);
        return { paint, measurement, faces: paint.faceTable.faces };
    } finally { active.delete(context); }
}
