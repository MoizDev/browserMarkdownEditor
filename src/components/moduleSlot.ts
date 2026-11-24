import { createElement, useEffect, useSyncExternalStore, type ComponentType, type ReactNode } from 'react';
import { loadChunk } from '../platform/chunkLoad';

/**
 * A lazily loaded component rendered DIRECTLY once its module has arrived, instead of through `React.lazy` behind a
 * `<Suspense>`. React 19 holds a suspended boundary's reveal until its fallback has been up 300 ms, whenever the chunk
 * landed: measured on a cold open, the PDF surface's chunk arrived ~20 ms after the click and the page still waited
 * for a timer of 291 ms with the main thread idle, then every later import of the open path started only after it.
 * A slot is a module snapshot: a warm load renders on the first pass, a cold one shows `fallback` until the module is
 * there and renders on the next pass with nothing throttling it. `load()` is shared, so an idle warm-up and the render
 * that needs the module wait on one import.
 *
 * A warm-up's failure is not the pane's: `load({ background: true })` that fails with no View waiting leaves the slot
 * idle, so the pane that mounts later imports afresh. It used to publish the error, and a slow first visit (the idle
 * warm-up of the canvas chunk timing out) showed "taking too long to download" the moment a board was opened, with no
 * attempt made for it — while the browser's own fetch had long since finished.
 *
 * The import goes through `loadChunk` (bounded, retried once, a gone chunk told apart), and a failure is thrown to the
 * nearest ErrorBoundary — whose Try again calls `retryFailedModuleSlots`, so the remounted View imports afresh instead
 * of rethrowing the failure it remembered (React.lazy, which this replaced, keeps a rejected import for the page).
 */
export interface ModuleSlot<P extends object> {
    /** Starts (or joins) the import; after a failure the next call imports again. `background` marks a warm-up
     * nobody is waiting on: its failure is not shown. */
    load(options?: { readonly background?: boolean }): Promise<ComponentType<P>>;
    /** Renders the component once loaded, `fallback` before; a failed import is thrown to the nearest error boundary as
     * `React.lazy` would. */
    readonly View: ComponentType<P & { readonly fallback?: ReactNode }>;
}

const failedSlots = new Set<() => void>();

/** Let every slot whose import failed try again on its next render (an ErrorBoundary's Try again). */
export function retryFailedModuleSlots(): void {
    for (const reset of [...failedSlots]) reset();
}

type Snapshot<P extends object> =
    | { readonly status: 'idle' | 'loading' }
    | { readonly status: 'ready'; readonly Component: ComponentType<P> }
    | { readonly status: 'error'; readonly error: unknown };

export function moduleSlot<P extends object>(importer: () => Promise<{ default: ComponentType<P> }>): ModuleSlot<P> {
    let snapshot: Snapshot<P> = { status: 'idle' };
    let task: Promise<ComponentType<P>> | null = null;
    // Whether a mounted View (or any caller that will show the outcome) has asked for the import now in flight.
    let wanted = false;
    const listeners = new Set<() => void>();
    const publish = (next: Snapshot<P>) => { snapshot = next; for (const listener of [...listeners]) listener(); };
    const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
    const read = () => snapshot;
    const reset = () => {
        failedSlots.delete(reset);
        if (snapshot.status === 'error') publish({ status: 'idle' });
    };
    const load = (options?: { readonly background?: boolean }): Promise<ComponentType<P>> => {
        if (!options?.background) wanted = true;
        if (task) return task;
        const next = loadChunk(importer).then(module => {
            publish({ status: 'ready', Component: module.default });
            return module.default;
        }, error => {
            // A cached failed import is retried by the next load (a remount or a warm-up), never in a loop.
            task = null;
            const shown = wanted;
            wanted = false;
            if (shown) {
                failedSlots.add(reset);
                publish({ status: 'error', error });
            } else publish({ status: 'idle' });
            throw error;
        });
        task = next;
        if (snapshot.status !== 'ready') publish({ status: 'loading' });
        return next;
    };
    function View(props: P & { readonly fallback?: ReactNode }) {
        const current = useSyncExternalStore(subscribe, read, read);
        // Also while a warm-up's import is in flight: joining it is what makes its outcome this View's to show.
        useEffect(() => { if (current.status === 'idle' || current.status === 'loading') void load().catch(() => {}); }, [current.status]);
        if (current.status === 'ready') {
            const { fallback: _fallback, ...rest } = props;
            return createElement(current.Component, rest as unknown as P);
        }
        if (current.status === 'error') throw current.error;
        return props.fallback ?? null;
    }
    return { load, View };
}
