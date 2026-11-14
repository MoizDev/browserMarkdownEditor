import { serve } from '../../platform/workers/serve';
import { isWorkerMessage, WorkerHostError } from '../../platform/workers/envelope';
import type { WorkerContext } from '../../platform/workers/serve';
import { frameRecord, positiveInteger, PDF_FRAME_VERSION, PDF_BROKER_BUILD } from './protocol';
import type { PdfBrokerSpawnResult, PdfFrameIdentity, PdfWorkerBinding, PdfWorkerBootstrap } from './protocol';

interface WorkerSlot {
    worker: Worker;
    role: 'render' | 'writer';
    generation: number;
    codeUrl: string;
    glueUrl: string;
    wasmUrl: string;
    port?: MessagePort;
    timer?: ReturnType<typeof setTimeout>;
    reject?: (error: Error) => void;
}
let identity: PdfFrameIdentity | undefined;
let control: MessagePort | undefined;
let stopServing: (() => void) | undefined;
let closed = false;
const slots = new Map<number, WorkerSlot>();
const protocolError = () => new WorkerHostError('Protocol', 'Invalid PDF worker bootstrap');

function drop(id: number): void {
    const slot = slots.get(id);
    if (!slot) return;
    slots.delete(id);
    clearTimeout(slot.timer);
    slot.reject?.(protocolError());
    slot.worker.terminate();
    slot.port?.close();
    for (const url of [slot.codeUrl, slot.glueUrl, slot.wasmUrl]) if (url) URL.revokeObjectURL(url);
}
function dispose(): void {
    if (closed) return;
    closed = true;
    stopServing?.();
    for (const id of [...slots.keys()]) drop(id);
    control?.close();
    control = undefined;
}

async function spawn(value: unknown, context: WorkerContext): Promise<PdfBrokerSpawnResult> {
    if (!frameRecord(value) || !identity || !positiveInteger(value.id) || !positiveInteger(value.generation) ||
        slots.has(value.id) || slots.size >= 5 || typeof value.workerSource !== 'string' ||
        value.workerSource.length < 1 || value.workerSource.length > 8 * 1024 * 1024 ||
        typeof value.glueSource !== 'string' || value.glueSource.length < 1 || value.glueSource.length > 1024 * 1024 ||
        !(value.wasm instanceof Blob) || value.wasm.type !== 'application/wasm' || !frameRecord(value.engine) ||
        value.wasm.size !== value.engine.wasmBytes || !['render', 'writer'].includes(value.engine.role as string)) throw protocolError();
    const data = value as unknown as PdfWorkerBootstrap;
    if (data.engine.role === 'writer' && [...slots.values()].some(slot => slot.role === 'writer')) throw protocolError();
    const codeUrl = URL.createObjectURL(new Blob([data.workerSource], { type: 'text/javascript' }));
    const glueUrl = URL.createObjectURL(new Blob([data.glueSource], { type: 'text/javascript' }));
    const wasmUrl = URL.createObjectURL(data.wasm);
    const channel = new MessageChannel();
    let worker: Worker;
    try { worker = new Worker(codeUrl, { type: 'module', name: `pdf-${data.engine.role}` }); }
    catch {
        for (const url of [codeUrl, glueUrl, wasmUrl]) URL.revokeObjectURL(url);
        channel.port1.close(); channel.port2.close(); throw protocolError();
    }
    const slot: WorkerSlot = { worker, role: data.engine.role, generation: data.generation,
        codeUrl, glueUrl, wasmUrl, port: channel.port1 };
    slots.set(data.id, slot);
    const result = await new Promise<PdfBrokerSpawnResult>((resolve, reject) => {
        slot.reject = reject;
        let sent = false;
        const failure = () => {
            if (slots.get(data.id) !== slot) return;
            context.emit('worker.failed', { id: data.id, generation: data.generation });
            drop(data.id);
        };
        const receive = ({ data: message }: MessageEvent<unknown>) => {
            if (slots.get(data.id) !== slot || !identity) return;
            if (!isWorkerMessage(message)) { failure(); return; }
            if ('hello' in message && !sent && message.hello.protocol === PDF_FRAME_VERSION && message.hello.buildId === 'pdf-worker-binding-v1') {
                sent = true;
                const args: PdfWorkerBinding = { nonce: identity.nonce, id: data.id, generation: data.generation,
                    port: channel.port2, glueUrl, abi: data.abi, engine: { ...data.engine, engineUrl: wasmUrl } };
                try { worker.postMessage({ v: 1, id: 1, op: 'worker.bind', args, priority: 0 }, [channel.port2]); }
                catch { channel.port2.close(); failure(); }
            } else if ('id' in message && message.id === 1 && sent && message.ok && frameRecord(message.result) && message.result.bound === true) {
                clearTimeout(slot.timer);
                slot.reject = undefined;
                worker.removeEventListener('message', receive);
                URL.revokeObjectURL(slot.codeUrl); slot.codeUrl = '';
                const port = slot.port!; slot.port = undefined;
                resolve({ id: data.id, generation: data.generation, engineUrl: wasmUrl, port });
            } else { failure(); }
        };
        worker.addEventListener('message', receive);
        worker.addEventListener('error', event => { event.preventDefault(); failure(); });
        worker.addEventListener('messageerror', failure);
        slot.timer = setTimeout(failure, 10_000);
    });
    if (context.cancelled || closed) { result.port.close(); drop(data.id); throw protocolError(); }
    context.transfer(result.port);
    return result;
}

function bind(event: MessageEvent<unknown>): void {
    if (closed || control || event.source !== parent || event.ports.length !== 1) return;
    const value = event.data;
    if (!frameRecord(value) || value.v !== PDF_FRAME_VERSION || value.kind !== 'pdf-frame.init' ||
        typeof value.nonce !== 'string' || !/^[a-f0-9]{64}$/.test(value.nonce) || !positiveInteger(value.epoch)) return;
    identity = { v: 1, nonce: value.nonce, epoch: value.epoch };
    control = event.ports[0];
    window.removeEventListener('message', bind);
    control.postMessage({ ...identity, kind: 'ready' });
    stopServing = serve({ protocol: PDF_FRAME_VERSION, buildId: PDF_BROKER_BUILD, endpoint: control,
        handlers: {
            'broker.spawn': spawn,
            'broker.ping': () => ({}),
            'broker.terminate': value => {
                if (!frameRecord(value) || !positiveInteger(value.id) || !positiveInteger(value.generation)) throw protocolError();
                if (slots.get(value.id)?.generation === value.generation) drop(value.id);
                return {};
            },
            'broker.compiled': value => {
                if (!frameRecord(value) || !positiveInteger(value.id) || !positiveInteger(value.generation)) throw protocolError();
                const slot = slots.get(value.id);
                if (slot?.generation === value.generation && slot.wasmUrl) {
                    URL.revokeObjectURL(slot.wasmUrl); slot.wasmUrl = '';
                }
                return {};
            },
        },
    });
}
window.addEventListener('message', bind);
window.addEventListener('pagehide', dispose, { once: true });
