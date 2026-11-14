import type { EmbedContainmentFactory } from '../../platform/embedContainment.types';
import type { EmbedHostingLease, EmbedPresentationPort } from '../../platform/render/embedPresentation.types';
import type { RenderToken } from '../../platform/render/types';
import { activateEmbed, resolveEmbedCandidate, type EmbedLease, type EmbedManifest } from '../media/embed';
import type { UrlEnvironment } from '../security/urlPolicy';
import type { BoardRuntime } from './runtime';

export type NativeEmbedState = 'inert' | 'loading' | 'loaded';
export interface NativeEmbedController {
    /** Explicit user consent for this exact node, source URL and view lifetime. */
    load(nodeId: string): Promise<EmbedHostingLease>;
    unload(nodeId: string): Promise<void>;
    state(nodeId: string): NativeEmbedState;
    subscribe(listener: () => void): () => void;
    setVisible(visible: boolean): void;
    dispose(): Promise<void>;
}
type Entry = { readonly source: string; readonly controller: AbortController; readonly task: Promise<EmbedHostingLease>;
    hosting?: EmbedHostingLease; foreign?: EmbedLease; loaded: boolean; cleanup?: Promise<void> };
const sameToken = (a: RenderToken, b: RenderToken) => a.vaultEpoch === b.vaultEpoch && a.documentId === b.documentId
    && a.bytesGeneration === b.bytesGeneration && a.session === b.session;

/** Session-only consent. This never writes a model flag, so undo, copy, restore and reopen cannot activate a provider. */
export function createNativeEmbedController(options: {
    readonly runtime: BoardRuntime;
    readonly token: RenderToken;
    /** Borrowed from the same viewer/compositor; the viewer, not this controller, owns this port. */
    readonly presentation: EmbedPresentationPort;
    readonly manifest: EmbedManifest;
    readonly containment: EmbedContainmentFactory;
    readonly environment: UrlEnvironment;
    current(): boolean;
    visible(): boolean;
    onError(error: unknown): void;
}): NativeEmbedController {
    const { runtime } = options, session = runtime.session, token = Object.freeze({ ...options.token });
    const entries = new Map<string, Entry>(), retiring = new Set<Promise<void>>(), listeners = new Set<() => void>();
    let disposed = false, shown = options.visible();
    const report = (error: unknown) => { try { options.onError(error); } catch { /* Reporting cannot keep consent alive. */ } };
    const notify = () => { for (const listener of listeners) { try { listener(); } catch (error) { report(error); } } };
    const current = () => !disposed && shown && options.visible() && options.current() && runtime.session === session
        && sameToken(runtime.paintToken, token) && session.owner.documentId === token.documentId && session.owner.session === token.session;
    const node = (id: string) => session.doc.nodes.get(id as Parameters<typeof session.doc.nodes.get>[0]);
    const eligible = (id: string, source: string) => { const value = node(id); return current() && value?.kind === 'embed' && value.url === source; };
    const release = (id: string, entry: Entry): Promise<void> => {
        if (entry.cleanup) return entry.cleanup;
        if (entries.get(id) === entry) entries.delete(id);
        entry.controller.abort(new DOMException('Embed consent ended', 'AbortError'));
        entry.foreign?.dispose();
        // Acquisition can ignore cancellation and finish late; wait for that exact task and close its actual hosting lease.
        const work = (async () => {
            try { await entry.task; } catch { /* The load caller receives the failure. */ }
            entry.foreign?.dispose(); await entry.hosting?.dispose();
        })();
        entry.cleanup = work; retiring.add(work); void work.catch(report).finally(() => retiring.delete(work)); notify();
        return work;
    };
    const stop = session.subscribe(() => {
        for (const [id, entry] of entries) if (!eligible(id, entry.source)) void release(id, entry);
    });
    return {
        load(id) {
            const existing = entries.get(id); if (existing) return existing.task;
            const value = node(id);
            if (!current() || value?.kind !== 'embed' || !resolveEmbedCandidate(value.url, options.environment, options.manifest)) {
                return Promise.reject(new Error('This embed is not available in the current view'));
            }
            const source = value.url, controller = new AbortController();
            // Start in a microtask so the consent entry exists before any acquisition callback can revoke it.
            const task = Promise.resolve().then(async () => {
                const hosting = await options.presentation.acquire(id, controller.signal);
                entry.hosting = hosting;
                const check = () => {
                    controller.signal.throwIfAborted(); hosting.signal.throwIfAborted();
                    if (!eligible(id, source) || hosting.getSnapshot().node?.source !== source) throw new DOMException('Embed source changed', 'AbortError');
                };
                const signal = AbortSignal.any([controller.signal, hosting.signal]);
                signal.addEventListener('abort', () => { entry.foreign?.dispose(); if (entries.get(id) === entry) void release(id, entry); }, { once: true });
                check();
                const foreign = await activateEmbed({ input: source, manifest: options.manifest, environment: options.environment,
                    container: hosting.container, containment: options.containment, signal,
                    identity: { session: `${token.documentId}:${token.session}`, epoch: token.vaultEpoch, revision: token.bytesGeneration },
                    current: () => eligible(id, source) && !signal.aborted,
                    onFailure(error) { report(error); if (entries.get(id) === entry) void release(id, entry); } });
                entry.foreign = foreign; check(); hosting.bind(foreign.containment); check();
                entry.loaded = true; notify(); return hosting;
            });
            const entry: Entry = { source, controller, task, loaded: false };
            entries.set(id, entry); notify();
            void task.catch(error => { if (!controller.signal.aborted) report(error); void release(id, entry); });
            return task;
        },
        unload(id) { const entry = entries.get(id); return entry ? release(id, entry) : Promise.resolve(); },
        state(id) { const entry = entries.get(id); return entry ? entry.loaded ? 'loaded' : 'loading' : 'inert'; },
        subscribe(listener) { if (disposed) return () => {}; listeners.add(listener); return () => { listeners.delete(listener); }; },
        setVisible(visible) {
            shown = visible;
            if (!visible) for (const [id, entry] of entries) void release(id, entry);
        },
        async dispose() {
            if (!disposed) {
                disposed = true; shown = false; stop();
                for (const [id, entry] of entries) void release(id, entry);
                listeners.clear();
            }
            while (retiring.size) await Promise.allSettled([...retiring]);
        },
    };
}
