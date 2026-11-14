import { createWorkerClient, cpuGovernor } from '../../platform/workers';
import type { IncrementalPdfPage, IncrementalPdfSession, IncrementalPdfWriter } from '../../whiteboard/export/incrementalPdf';
import type { IncrementalEmittedPdf, IncrementalOperation } from './incrementalTypes';
export type { IncrementalEmittedPdf } from './incrementalTypes';

const aborted = () => new DOMException('PDF export cancelled', 'AbortError');
let nextSession = 0;

/** Each session has one lazy worker and at most one in-flight chunk. */
export function createIncrementalPdfWriter(options: {
    onFinish?: (emitted: IncrementalEmittedPdf, signal: AbortSignal) => Promise<Uint8Array>;
} = {}): IncrementalPdfWriter {
    return {
        kind: 'incremental-pdf',
        async open(input, signal) {
            signal.throwIfAborted();
            if (input.notebookSource && !options.onFinish) throw new Error('Notebook source requires the native notebook finalizer');
            const client = createWorkerClient({ name: `pdf-incremental-${++nextSession}`, protocol: 1, permits: cpuGovernor,
                spawn: () => new Worker(new URL('./incrementalWorker.ts', import.meta.url), { type: 'module' }) });
            let closed = false, busy = false, generation: number | undefined;
            const lifetime = new AbortController(), retirements = new Set<Promise<void>>();
            let finalizing: Promise<Uint8Array> | undefined;
            const cancel = () => {
                if (closed) return;
                closed = true; lifetime.abort(); client.dispose();
            };
            const send = async (operation: IncrementalOperation, requestSignal: AbortSignal): Promise<IncrementalEmittedPdf | undefined> => {
                if (closed || requestSignal.aborted) { cancel(); throw aborted(); }
                if (busy) { cancel(); throw new Error('Concurrent PDF export requests are not allowed'); }
                if (generation !== undefined && client.generation !== generation) { cancel(); throw new Error('PDF export worker was replaced'); }
                busy = true;
                const request = client.request<IncrementalEmittedPdf | undefined>('step', operation,
                    { priority: 2, cpu: 'governed', signal: requestSignal });
                const retired = client.whenRetired(request);
                retirements.add(retired);
                void retired.then(() => retirements.delete(retired));
                try {
                    const result = await request;
                    if (closed || requestSignal.aborted) throw aborted();
                    if (generation === undefined) generation = client.generation;
                    else if (client.generation !== generation) throw new Error('PDF export worker was replaced');
                    return result;
                } catch (error) { cancel(); throw error; }
                finally { busy = false; }
            };
            try { await send({ kind: 'open', revision: input.revision, pageCount: input.pageCount }, signal); }
            catch (error) { cancel(); await Promise.all([...retirements]); throw error; }
            let activePage: IncrementalPdfPage | null = null;
            const session: IncrementalPdfSession = {
                async beginPage(page, requestSignal) {
                    if (activePage) { cancel(); throw new Error('PDF page already open'); }
                    await send({ kind: 'beginPage', page }, requestSignal);
                    const pageSend = async (operation: IncrementalOperation, s: AbortSignal) => {
                        if (activePage !== current) { cancel(); throw new Error('PDF page is no longer active'); }
                        await send(operation, s);
                    };
                    const current: IncrementalPdfPage = {
                        async beginGroup(group, s) { await pageSend({ kind: 'beginGroup', group }, s); },
                        async endGroup(s) { await pageSend({ kind: 'endGroup' }, s); },
                        async beginPath(path, s) { await pageSend({ kind: 'beginPath', path }, s); },
                        async pathCommands(commands, s) { if (commands.length > 1024) { cancel(); throw new RangeError('PDF path chunk exceeds 1024 commands'); } await pageSend({ kind: 'pathCommands', commands }, s); },
                        async endPath(s) { await pageSend({ kind: 'endPath' }, s); },
                        async image(item, s) { await pageSend({ kind: 'image', item }, s); },
                    };
                    activePage = current; return current;
                },
                async endPage(page, requestSignal) {
                    if (page !== activePage || !page) { cancel(); throw new Error('PDF page does not match'); }
                    await send({ kind: 'endPage' }, requestSignal); activePage = null;
                },
                async finish(requestSignal) {
                    if (activePage) { cancel(); throw new Error('PDF page remains open'); }
                    try {
                        const emitted = await send({ kind: 'finish' }, requestSignal);
                        if (!emitted || emitted.revision !== input.revision || !(emitted.bytes instanceof Uint8Array) || !emitted.bytes.length ||
                            !Array.isArray(emitted.pages) || emitted.pages.length !== input.pageCount || !Array.isArray(emitted.hashes) ||
                            emitted.hashes.length !== input.pageCount || emitted.hashes.some(hash => typeof hash !== 'string' || !/^[0-9a-f]{64}$/.test(hash)) ||
                            emitted.pages.some((page, i) => !page || page.index !== i || !Number.isFinite(page.width) || page.width <= 0 || page.width > 14_400 ||
                                !Number.isFinite(page.height) || page.height <= 0 || page.height > 14_400)) throw new Error('Invalid PDF export result');
                        const finishSignal = AbortSignal.any([requestSignal, lifetime.signal]);
                        finishSignal.throwIfAborted();
                        finalizing = options.onFinish ? options.onFinish(emitted, finishSignal) : Promise.resolve(emitted.bytes);
                        const bytes = await finalizing;
                        finishSignal.throwIfAborted();
                        if (!(bytes instanceof Uint8Array) || !bytes.length) throw new Error('Invalid final PDF');
                        return bytes;
                    } finally { cancel(); await Promise.all([...retirements]); }
                },
                async cancel() { cancel(); await Promise.all([...retirements]); await finalizing?.then(() => {}, () => {}); },
            };
            return session;
        },
    };
}
