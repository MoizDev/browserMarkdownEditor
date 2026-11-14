import { useCallback, useLayoutEffect, useRef, useSyncExternalStore, type RefObject } from 'react';
import type { PlatformLayerDefinition, PlatformPane, PlatformPaneOptions } from '../../platform/render';
import { getSessionIdentity, subscribeSessionIdentity } from '../../utils/sessionIdentity';

export interface UsePlatformPaneOptions<T extends object> {
    readonly host: HTMLElement | null;
    readonly isVisible: boolean;
    readonly isFocused: boolean;
    readonly vaultEpoch: number;
    readonly documentId: string;
    readonly layers: readonly PlatformLayerDefinition[];
    /** App/session-owned services and callbacks must remain stable for the document session. */
    readonly services: Omit<PlatformPaneOptions<T>, 'documentToken' | 'initialVisible' | 'initialFocused' | 'layers'>;
}

/**
 * Only a live App session may attach. The lazy import keeps the platform out of Markdown-only
 * startup; cleanup cancels an unresolved import and disposes an attached pane (design §16.1 PL2).
 */
export function usePlatformPane<T extends object>(options: UsePlatformPaneOptions<T>): RefObject<PlatformPane | null> {
    const { host, isVisible, isFocused, vaultEpoch, documentId, layers, services } = options;
    const readIdentity = useCallback(() => {
        const identity = getSessionIdentity(documentId);
        return identity ? `${identity.serial}:${identity.bytesGeneration}` : null;
    }, [documentId]);
    const identity = useSyncExternalStore(subscribeSessionIdentity, readIdentity, readIdentity);
    const pane = useRef<PlatformPane | null>(null);
    const current = useRef({ isVisible, isFocused, layers });

    useLayoutEffect(() => {
        current.current = { isVisible, isFocused, layers };
    }, [isVisible, isFocused, layers]);
    useLayoutEffect(() => { pane.current?.setLayers(layers); }, [layers]);
    useLayoutEffect(() => { pane.current?.setVisible(isVisible); }, [isVisible]);
    useLayoutEffect(() => { pane.current?.setFocused(isFocused); }, [isFocused]);

    useLayoutEffect(() => {
        if (!host || identity === null) return;
        const [session, bytesGeneration] = identity.split(':').map(Number);
        let cancelled = false;
        void import('../../platform/render/attachPlatformPane').then(({ attachPlatformPane }) => {
            if (cancelled) return;
            const state = current.current;
            const attached = attachPlatformPane(host, {
                ...services,
                documentToken: { vaultEpoch, documentId, session, bytesGeneration },
                initialVisible: state.isVisible,
                initialFocused: state.isFocused,
                layers: state.layers,
            });
            if (cancelled) attached.dispose();
            else pane.current = attached;
        }).catch(error => {
            if (!cancelled) services.onError(error);
        });
        return () => {
            cancelled = true;
            const attached = pane.current;
            pane.current = null;
            attached?.dispose();
        };
    }, [host, identity, vaultEpoch, documentId, services]);

    return pane;
}
