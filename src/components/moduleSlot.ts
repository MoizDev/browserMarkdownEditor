import { createElement, useEffect, useSyncExternalStore, type ComponentType, type ReactNode } from 'react';

/**
 * A lazily loaded component rendered DIRECTLY once its module has arrived, instead of through `React.lazy` behind a
 * `<Suspense>`. React 19 holds a suspended boundary's reveal until its fallback has been up 300 ms, whenever the chunk
 * landed: measured on a cold open, the PDF surface's chunk arrived ~20 ms after the click and the page still waited
 * for a timer of 291 ms with the main thread idle, then every later import of the open path started only after it.
 * A slot is a module snapshot: a warm load renders on the first pass, a cold one shows `fallback` until the module is
 * there and renders on the next pass with nothing throttling it. `load()` is shared, so an idle warm-up and the render
 * that needs the module wait on one import.
 */
export interface ModuleSlot<P extends object> {
    /** Starts (or joins) the import; after a failure the next call imports again. */
    load(): Promise<ComponentType<P>>;
    /** Renders the component once loaded, `fallback` before; a failed import is thrown to the nearest error boundary as
     * `React.lazy` would. */
    readonly View: ComponentType<P & { readonly fallback?: ReactNode }>;
}

type Snapshot<P extends object> =
    | { readonly status: 'idle' | 'loading' }
    | { readonly status: 'ready'; readonly Component: ComponentType<P> }
    | { readonly status: 'error'; readonly error: unknown };

export function moduleSlot<P extends object>(importer: () => Promise<{ default: ComponentType<P> }>): ModuleSlot<P> {
    let snapshot: Snapshot<P> = { status: 'idle' };
    let task: Promise<ComponentType<P>> | null = null;
    const listeners = new Set<() => void>();
    const publish = (next: Snapshot<P>) => { snapshot = next; for (const listener of [...listeners]) listener(); };
    const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
    const read = () => snapshot;
    const load = (): Promise<ComponentType<P>> => {
        if (task) return task;
        const next = importer().then(module => {
            publish({ status: 'ready', Component: module.default });
            return module.default;
        }, error => {
            // A cached failed import is retried by the next load (a remount or a warm-up), never in a loop.
            task = null;
            publish({ status: 'error', error });
            throw error;
        });
        task = next;
        if (snapshot.status !== 'ready') publish({ status: 'loading' });
        return next;
    };
    function View(props: P & { readonly fallback?: ReactNode }) {
        const current = useSyncExternalStore(subscribe, read, read);
        useEffect(() => { if (current.status === 'idle') void load().catch(() => {}); }, [current.status]);
        if (current.status === 'ready') {
            const { fallback: _fallback, ...rest } = props;
            return createElement(current.Component, rest as unknown as P);
        }
        if (current.status === 'error') throw current.error;
        return props.fallback ?? null;
    }
    return { load, View };
}
