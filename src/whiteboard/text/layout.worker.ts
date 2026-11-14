import { serve, type WorkerContext } from '../../platform/workers';
import { BoardFonts, type FontKey } from './fonts';
import { BoardTextLayout } from './layout';
import { ReferenceMeasurer } from './measure';
import type { TextLayoutRequest } from './paint';

let engine: BoardTextLayout | undefined;
let fonts: BoardFonts | undefined;
let notify: ((epoch: number, key: FontKey) => void) | undefined;
function getEngine(): BoardTextLayout {
    if (engine) return engine;
    const canvas = new OffscreenCanvas(1, 1);
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Text layout needs an OffscreenCanvas 2D context');
    fonts = new BoardFonts((globalThis as unknown as { fonts: FontFaceSet }).fonts);
    fonts.subscribe((epoch, key) => notify?.(epoch, key));
    engine = new BoardTextLayout(new ReferenceMeasurer(context), fonts);
    return engine;
}
async function layout(args: unknown, context: WorkerContext) {
    const request = args as TextLayoutRequest;
    const current = getEngine();
    notify = (epoch, key) => context.emit('fontEpoch', { epoch, key });
    await current.prepare(request);
    if (context.cancelled) throw new Error('Text layout cancelled');
    const resolved = { ...request, fontEpoch: fonts!.epoch };
    const paint = current.layout(resolved);
    return { paint, measurement: current.measure(resolved), faces: current.faceTable.faces.slice() };
}
serve({ protocol: 1, buildId: 'whiteboard-text-1', capabilities: ['layout'], handlers: { layout } });
