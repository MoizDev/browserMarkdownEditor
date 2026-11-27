let post: ((resolve: () => void) => void) | undefined;

function createPost(): (resolve: () => void) => void {
    if (typeof MessageChannel !== 'function') return resolve => { setTimeout(resolve, 0); };
    const channel = new MessageChannel(), waiting: Array<() => void> = [];
    channel.port1.onmessage = () => { waiting.shift()?.(); };
    return resolve => { waiting.push(resolve); channel.port2.postMessage(null); };
}

export function yieldToHost(): Promise<void> {
    return new Promise<void>(resolve => { (post ??= createPost())(resolve); });
}
