import { useCallback, useLayoutEffect, useRef, useSyncExternalStore, type RefObject } from 'react';
import type { PlatformLayerDefinition, PlatformPane, PlatformPaneOptions } from '../../platform/render';
import type { RenderToken } from '../../platform/render/types';
import { getSessionIdentity, subscribeSessionIdentity } from '../../utils/sessionIdentity';
import { loadChunk } from '../../platform/chunkLoad';

export interface UsePlatformPaneOptions<T extends object> {
    readonly host: HTMLElement | null;
    readonly isVisible: boolean;
    readonly isFocused: boolean;
    readonly vaultEpoch: number;
    readonly documentId: string;
    /** A session-owned source may outlive outer document byte swaps. */
    readonly sourceToken?: RenderToken;
    readonly layers: readonly PlatformLayerDefinition[];
    /** Input borrows the attached pane for scheduler motion, never a second camera loop. */
    readonly onPane?: (pane: PlatformPane | null) => void;
    /** App/session-owned services and callbacks must remain stable for the document session. */
    readonly services: Omit<PlatformPaneOptions<T>, 'documentToken' | 'initialVisible' | 'initialFocused' | 'layers'>;
}

/**
 * Only a live App session may attach. The lazy import keeps the platform out of Markdown-only
 * startup; cleanup cancels an unresolved import and disposes an attached pane (design §16.1 PL2).
 */
export function usePlatformPane<T extends object>(options: UsePlatformPaneOptions<T>): RefObject<PlatformPane | null> {
    const { host, isVisible, isFocused, vaultEpoch, documentId, layers, services, sourceToken } = options;
    const sourceDocument = sourceToken?.documentId, sourceSession = sourceToken?.session;
    const sourceEpoch = sourceToken?.vaultEpoch, sourceGeneration = sourceToken?.bytesGeneration;
    const readIdentity = useCallback(() => {
        const identity = getSessionIdentity(documentId);
        if (!identity) return null;
        if (sourceGeneration !== undefined) {
            if (sourceDocument !== documentId || sourceEpoch !== vaultEpoch || sourceSession !== identity.serial) return null;
            return `${identity.serial}:${sourceGeneration}`;
        }
        return `${identity.serial}:${identity.bytesGeneration}`;
    }, [documentId, vaultEpoch, sourceDocument, sourceEpoch, sourceSession, sourceGeneration]);
    const identity = useSyncExternalStore(subscribeSessionIdentity, readIdentity, readIdentity);
    const pane = useRef<PlatformPane | null>(null);
    const current = useRef({ isVisible, isFocused, layers });
    const onPane = useRef(options.onPane);

    useLayoutEffect(() => {
        current.current = { isVisible, isFocused, layers };
        onPane.current = options.onPane;
    }, [isVisible, isFocused, layers, options.onPane]);
    // Hide before a simultaneous layer replacement can schedule any more view work.
    useLayoutEffect(() => { pane.current?.setVisible(isVisible); }, [isVisible]);
    useLayoutEffect(() => { pane.current?.setFocused(isFocused); }, [isFocused]);
    useLayoutEffect(() => { pane.current?.setLayers(layers); }, [layers]);

    useLayoutEffect(() => {
        if (!host || identity === null) return;
        const [session, bytesGeneration] = identity.split(':').map(Number);
        const token = { vaultEpoch, documentId, session, bytesGeneration };
        const tokenCurrent = () => {
            if (sourceGeneration === undefined) return true;
            const live = getSessionIdentity(documentId), actual = services.currentToken();
            return !!live && live.serial === session && !!actual && actual.documentId === documentId
                && actual.vaultEpoch === vaultEpoch && actual.session === session && actual.bytesGeneration === bytesGeneration;
        };
        if (!tokenCurrent()) return;
        let cancelled = false;
        let owned: PlatformPane | null = null;
        void loadChunk(() => import('../../platform/render/cpuEntry')).then(({ attachPlatformPane }) => {
            if (cancelled || !tokenCurrent()) return;
            const state = current.current;
            const attached = attachPlatformPane(host, {
                ...services,
                documentToken: token,
                initialVisible: state.isVisible,
                initialFocused: state.isFocused,
                layers: state.layers,
            });
            if (cancelled) attached.dispose();
            else {
                owned = attached;
                pane.current = attached;
                onPane.current?.(attached);
            }
        }).catch(error => {
            if (!cancelled) services.onError(error);
        });
        return () => {
            cancelled = true;
            if (pane.current === owned) {
                pane.current = null;
                // Cancel captured contacts/motion while their platform is still alive.
                try { onPane.current?.(null); } catch (error) { services.onError(error); }
            }
            owned?.dispose();
            owned = null;
        };
    }, [host, identity, vaultEpoch, documentId, services, sourceGeneration]);

    return pane;
}
