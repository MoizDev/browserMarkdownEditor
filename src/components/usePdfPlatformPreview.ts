import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { RefObject } from 'react';
import { routeEngines } from '../utils/engineRouting';
import { getSessionIdentity, subscribeSessionIdentity } from '../utils/sessionIdentity';
import type { PdfPreview, PreviewSnapshot } from '../pdf/preview/contracts';

interface ReaderIdentity {
    readonly vaultEpoch: number;
    readonly documentId: string;
    readonly byteGeneration: number;
}

/** The platform is imported only after both the developer route and App's session identity exist. */
export function usePdfPlatformPreview(
    root: RefObject<HTMLDivElement | null>,
    identity: ReaderIdentity | undefined,
    source: object,
    visible: boolean,
    focused: boolean,
    readSnapshot: () => PreviewSnapshot | null,
): () => void {
    const [active] = useState(() => routeEngines().platformLayer);
    const snapshotRef = useRef(readSnapshot);
    snapshotRef.current = readSnapshot;
    const previewRef = useRef<PdfPreview | null>(null);
    const visibleRef = useRef(visible);
    visibleRef.current = visible;
    const focusedRef = useRef(focused);
    focusedRef.current = focused;
    const documentId = identity?.documentId;
    const vaultEpoch = identity?.vaultEpoch;
    const byteGeneration = identity?.byteGeneration;
    const getSerial = useCallback(() => {
        if (!active || !documentId) return 0;
        const entry = getSessionIdentity(documentId);
        return entry && entry.bytesGeneration === byteGeneration ? entry.serial : 0;
    }, [active, documentId, byteGeneration]);
    const serial = useSyncExternalStore(subscribeSessionIdentity, getSerial);

    useEffect(() => {
        if (!active || !serial || !documentId || vaultEpoch === undefined || byteGeneration === undefined) return;
        let cancelled = false;
        let preview: PdfPreview | null = null;
        void import('../pdf/preview/attach').then(({ createPdfPreview }) => {
            if (cancelled || !root.current) return;
            preview = createPdfPreview({
                root: root.current,
                token: { vaultEpoch, documentId, bytesGeneration: byteGeneration, session: serial },
                readSnapshot: () => snapshotRef.current(),
            });
            previewRef.current = preview;
            preview.setFocused(focusedRef.current);
            preview.setVisible(visibleRef.current);
            preview.sync();
        }).catch(error => { if (!cancelled) console.error('Could not attach PDF platform preview:', error); });
        return () => {
            cancelled = true;
            if (previewRef.current === preview) previewRef.current = null;
            preview?.dispose();
        };
    }, [active, serial, documentId, vaultEpoch, byteGeneration, root, source]);

    useLayoutEffect(() => {
        previewRef.current?.setVisible(visible);
        if (visible) previewRef.current?.sync();
    }, [visible]);
    useEffect(() => { previewRef.current?.setFocused(focused); }, [focused]);
    return useCallback(() => previewRef.current?.sync(), []);
}
