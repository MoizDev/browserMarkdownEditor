import { IncrementalEmitter } from './incrementalEmit';
import type { IncrementalOperation } from './incrementalTypes';

const emitter = new IncrementalEmitter();
let busy = false, closed = false;
self.onmessage = (event: MessageEvent<{ id: number; operation: IncrementalOperation }>) => {
    const { id, operation } = event.data;
    if (closed || busy) { self.postMessage({ id, ok: false }); closed = true; return; }
    busy = true;
    void emitter.run(operation).then(result => {
        if (result) {
            closed = true;
            self.postMessage({ id, ok: true, result }, { transfer: [result.bytes.buffer] });
        } else self.postMessage({ id, ok: true });
    }, () => { closed = true; self.postMessage({ id, ok: false }); }).finally(() => { busy = false; });
};
