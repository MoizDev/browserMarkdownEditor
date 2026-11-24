// The one cooperative yield of the app, on the main thread and in every worker: a MessageChannel turn, which is one
// macrotask behind whatever is already queued, never clamped, never throttled in a background tab.
//
// Not setTimeout(0): nested timers are clamped to 4 ms, measured 4.8–5.6 ms per yield inside a worker (CfT 157) against
// 0.002 ms for this hop, so a legacy board conversion that yields a few times per shape cost ~24 ms a shape, and a
// 1 MB / ~2,000-shape board ran past its 30 s deadline.
// Not scheduler.yield(): Chrome 94–128 have `scheduler` without `yield` (an unguarded call failed every board there), and
// where it exists its continuation outranks every ordinary task. Measured (CfT 157, 1 ms of work between yields): in a
// worker a message posted 50 ms in was never delivered during 300 ms of yielding, so a cancel or a pause could not reach
// the task; on the main thread a 50 ms timer and a worker reply were both held for the whole 400 ms. A MessageChannel
// turn delivered both at 51–60 ms and still let a frame paint at 9 ms.
let post: ((resolve: () => void) => void) | undefined;

function createPost(): (resolve: () => void) => void {
    if (typeof MessageChannel !== 'function') return resolve => { setTimeout(resolve, 0); };
    const channel = new MessageChannel(), waiting: Array<() => void> = [];
    channel.port1.onmessage = () => { waiting.shift()?.(); };
    return resolve => { waiting.push(resolve); channel.port2.postMessage(null); };
}

/** Resolves after one macrotask turn: input, rendering, timers and messages queued before it all run first. */
export function yieldToHost(): Promise<void> {
    return new Promise<void>(resolve => { (post ??= createPost())(resolve); });
}
