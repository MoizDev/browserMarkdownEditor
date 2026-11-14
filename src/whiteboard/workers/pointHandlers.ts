import type { WorkerContext } from '../../platform/workers';
import { decodePointsIncremental, inspectPointsIncremental } from '../format/points';
import type { PointChannel } from '../format/points';

function pointsArgument(payload: unknown): string {
    if (!payload || typeof payload !== 'object' || typeof (payload as { pts?: unknown }).pts !== 'string') {
        throw new TypeError('Invalid encoded point request');
    }
    return (payload as { pts: string }).pts;
}
export async function inspectPoints(payload: unknown, context: WorkerContext) {
    return inspectPointsIncremental(pointsArgument(payload), () => context.slice());
}
export async function decodePoints(payload: unknown, context: WorkerContext) {
    const result = await decodePointsIncremental(pointsArgument(payload), () => context.slice());
    if (!result.ok) return result;
    const decoded = result.value;
    const channels: PointChannel[] = [];
    const buffers = new Set<ArrayBuffer>();
    buffers.add(decoded.xy.buffer as ArrayBuffer);
    if (decoded.pressure) buffers.add(decoded.pressure.buffer as ArrayBuffer);
    if (decoded.runs) {
        buffers.add(decoded.runs.starts.buffer as ArrayBuffer);
        buffers.add(decoded.runs.kinds.buffer as ArrayBuffer);
    }
    for (const channel of decoded.unknownChannels) {
        channels.push(channel);
        buffers.add(channel.data.buffer as ArrayBuffer);
        if ((channels.length & 255) === 0) await context.slice();
    }
    await context.slice();
    context.transfer(...buffers);
    return { ok: true as const, value: { ...decoded, unknownChannels: channels } };
}
