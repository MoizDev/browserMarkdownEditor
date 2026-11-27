import { createElement, useEffect, useSyncExternalStore, type ComponentType, type ReactNode } from 'react';
import { loadChunk } from '../platform/chunkLoad';

export interface ModuleSlot<P extends object> {
    load(options?: { readonly background?: boolean }): Promise<ComponentType<P>>;
    readonly View: ComponentType<P & { readonly fallback?: ReactNode }>;
}

const failedSlots = new Set<() => void>();

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
