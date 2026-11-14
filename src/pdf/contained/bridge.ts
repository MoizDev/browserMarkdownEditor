import { runtime, hash } from 'virtual:pdf-engine-broker';
import { createContainedFrame } from '../../platform/containedFrame';
import type { ContainedFrame } from '../../platform/containedFrame';
import { createWorkerClient } from '../../platform/workers/client';
import type { ContainedPort, WorkerClient } from '../../platform/workers/envelope';
import { isWorkerMessage } from '../../platform/workers/envelope';
import { PdfEngineError, RENDER_ENGINE_LIMITS, WRITER_ENGINE_LIMITS } from '../engine/types';
import type { PdfEngineRole } from '../engine/types';
import { PDF_ENGINE_PROTOCOL, PDF_ENGINE_ROLE_VERSION } from '../worker/protocol';
import type { EngineInitArgs } from '../worker/protocol';
import type { TrustedPdfAssets } from './assets';
import { PDF_FRAME_VERSION, PDF_BROKER_BUILD, frameRecord, positiveInteger } from './protocol';
import type { PdfBrokerSpawnResult, PdfFrameInit, PdfWorkerBootstrap } from './protocol';

let nextEpoch = 0;
interface Connection { port?: MessagePort; closed: boolean }
export interface PdfEnginePort extends ContainedPort {
    readonly engine: EngineInitArgs;
    compiled(): Promise<void>;
}
const broken = () => new PdfEngineError('EngineBroken', 'The contained PDF engine is unavailable');

/** The broker has no PDF bytes or render replies. Each returned port is a direct
 * worker channel; only worker creation/liveness crosses the tiny frame. */
export class PdfEngineFrame {
    private readonly epoch = ++nextEpoch;
    private readonly nonce = [...crypto.getRandomValues(new Uint8Array(32))].map(byte => byte.toString(16).padStart(2, '0')).join('');
    private readonly broker: WorkerClient;
    private frame?: ContainedFrame;
    private closed = false;
    private readonly connections = new Map<string, Connection>();

    constructor(private readonly assets: TrustedPdfAssets, private readonly workerSource: string,
        private readonly onFailure: (error: PdfEngineError) => void) {
        this.broker = createWorkerClient({ name: `pdf-broker:${this.nonce}`, protocol: PDF_FRAME_VERSION,
            spawn: () => this.mount(), events: ['worker.failed'], absoluteMs: 10_000,
            disposeResult: (op, value) => {
                if (op === 'broker.spawn' && frameRecord(value)) {
                    if (value.port instanceof MessagePort) value.port.close();
                    if (positiveInteger(value.id) && positiveInteger(value.generation)) this.terminateWorker(`${value.id}:${value.generation}`, value.id, value.generation);
                }
            } });
        this.broker.on('worker.failed', value => {
            if (!frameRecord(value) || !positiveInteger(value.id) || !positiveInteger(value.generation)) { this.fail(); return; }
            const connection = this.connections.get(`${value.id}:${value.generation}`);
            if (!connection) { this.fail(); return; }
            connection.closed = true;
            // A MessagePort close is not observable; deliver the broker's validated lifecycle failure.
            connection.port?.dispatchEvent(new MessageEvent('messageerror'));
        });
    }

    private mount(): Promise<ContainedPort> {
        if (this.closed || this.frame) return Promise.reject(broken());
        return new Promise((resolve, reject) => {
            let ready = false;
            const init: PdfFrameInit = { v: 1, kind: 'pdf-frame.init', nonce: this.nonce, epoch: this.epoch };
            const timer = setTimeout(() => { reject(broken()); this.fail(); }, 10_000);
            // Only fixed first-party script is interpolated. No PDF string, source path or markup enters srcdoc.
            const csp = `default-src 'none'; script-src 'sha256-${hash}' 'wasm-unsafe-eval' blob:; script-src-attr 'none'; worker-src blob:; connect-src blob:; style-src 'none'; img-src 'none'; font-src 'none'; media-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-src 'none'`;
            const html = `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${csp}"></head><body><script>${runtime}</script></body></html>`;
            const frame = createContainedFrame({ html, init, hidden: true,
                onMessage: event => {
                    if (this.closed) return;
                    const value: unknown = event.data;
                    if (!ready) {
                        if (!frameRecord(value) || value.kind !== 'ready' || value.v !== 1 || value.nonce !== this.nonce || value.epoch !== this.epoch) {
                            reject(broken()); this.fail(); return;
                        }
                        ready = true; clearTimeout(timer);
                        resolve({ port: frame.port, terminate: () => { frame.dispose(); if (this.frame === frame) this.frame = undefined; },
                            alive: async () => !this.closed && this.frame === frame && frame.frame.isConnected });
                    } else if (!isWorkerMessage(value) || ('hello' in value && value.hello.buildId !== PDF_BROKER_BUILD)) this.fail();
                },
                onFailure: () => { clearTimeout(timer); reject(broken()); this.fail(); },
            });
            this.frame = frame;
            frame.frame.style.display = 'none';
            try { frame.mount(document.body); }
            catch { clearTimeout(timer); frame.dispose(); this.frame = undefined; reject(broken()); }
        });
    }

    async spawn(role: PdfEngineRole, id: number, generation: number, signal?: AbortSignal): Promise<PdfEnginePort> {
        if (this.closed || !positiveInteger(id) || !positiveInteger(generation)) throw broken();
        const key = `${id}:${generation}`;
        if (this.connections.has(key)) throw broken();
        const connection: Connection = { closed: false };
        this.connections.set(key, connection);
        const engine: Omit<EngineInitArgs, 'engineUrl'> = {
            buildId: this.assets.buildId, artifactSha256: this.assets.artifactSha256, assetBase: this.assets.assetBase,
            wasmBytes: this.assets.wasmBytes, role, protocol: PDF_ENGINE_PROTOCOL, roleVersion: PDF_ENGINE_ROLE_VERSION,
            limits: role === 'render' ? RENDER_ENGINE_LIMITS : WRITER_ENGINE_LIMITS,
        };
        const args: PdfWorkerBootstrap = { id, generation, engine, abi: this.assets.abi,
            workerSource: this.workerSource, glueSource: this.assets.glueSource, wasm: this.assets.wasm };
        let value: unknown;
        try { value = await this.broker.request<unknown>('broker.spawn', args,
            { priority: 0, signal, deadlineMs: 10_000, cpu: 'light' }); }
        catch (error) { this.terminateWorker(key, id, generation); throw error; }
        if (!frameRecord(value) || this.closed || connection.closed || value.id !== id || value.generation !== generation ||
            !(value.port instanceof MessagePort) || typeof value.engineUrl !== 'string' ||
            !value.engineUrl.startsWith('blob:null/') || value.engineUrl.length > 4096) {
            if (frameRecord(value) && value.port instanceof MessagePort) value.port.close();
            this.terminateWorker(key, id, generation); this.fail(); throw broken();
        }
        const result = value as unknown as PdfBrokerSpawnResult;
        connection.port = result.port;
        return { port: result.port, engine: { ...engine, engineUrl: result.engineUrl },
            terminate: () => this.terminateWorker(key, id, generation),
            alive: async () => !connection.closed && !this.closed && await this.ping(),
            compiled: async () => { await this.broker.request('broker.compiled', { id, generation }, { priority: 0, cpu: 'light' }); },
        };
    }

    private terminateWorker(key: string, id: number, generation: number): void {
        const connection = this.connections.get(key);
        if (connection) { connection.closed = true; connection.port?.close(); }
        if (this.closed) { this.connections.delete(key); return; }
        // Keep the tombstone until the ordered terminate acknowledgement. A queued lifecycle
        // failure for this same worker is legitimate, not an unsolicited-frame trust failure.
        void this.broker.request('broker.terminate', { id, generation }, { priority: 0, cpu: 'light' })
            .catch(() => {}).then(() => { this.connections.delete(key); });
    }

    async ping(): Promise<boolean> {
        if (this.closed) return false;
        try { await this.broker.request('broker.ping', {}, { priority: 0, deadlineMs: 2000, cpu: 'light' }); return true; }
        catch { this.fail(); return false; }
    }
    private fail(): void {
        if (this.closed) return;
        this.dispose();
        this.onFailure(broken());
    }
    dispose(): void {
        if (this.closed) return;
        this.closed = true;
        for (const connection of this.connections.values()) {
            connection.closed = true;
            connection.port?.dispatchEvent(new MessageEvent('messageerror'));
            connection.port?.close();
        }
        this.connections.clear();
        this.broker.dispose(); this.frame?.dispose(); this.frame = undefined;
    }
}
