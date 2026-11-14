import { useEffect, useState, useSyncExternalStore } from 'react';
import type { PdfReadingBinding } from '../types/reading';
import type { PdfFindMemory } from '../utils/pdfFindHighlight';
import type { PdfRotationPicture } from '../utils/pdfRotationPreview';
import { getSessionIdentity, subscribeSessionIdentity } from '../utils/sessionIdentity';
import type { PdfTiledSource } from './PdfTiledView';
import PdfTiledView from './PdfTiledView';
import PdfPasswordCoordinator from './PdfPasswordCoordinator';

interface Props {
    reading: PdfReadingBinding;
    filePath: string;
    visible: boolean;
    focused: boolean;
    /** Open the shared source without mounting the Original compositor. */
    sourceOnly?: boolean;
    sourceHash?: string;
    findMemory: PdfFindMemory;
    searchVault(query: string): void;
    rotate(delta: number, page?: number, picture?: PdfRotationPicture): void;
    openText(page?: number): void;
    openClassic(): void;
    onSource(source: PdfTiledSource): void;
    notify(message: string): void;
}

/** A view can come and go; the factory parks its immutable source in the
 * App-owned document slot, with no extra document or worker on a graph trip. */
export default function PdfTiledSurface(props: Props) {
    const { reading, onSource } = props;
    const identity = useSyncExternalStore(subscribeSessionIdentity,
        () => getSessionIdentity(reading.identity.documentId), () => undefined);
    const [loaded, setLoaded] = useState<{ key: string; source: PdfTiledSource } | null>(null);
    const [error, setError] = useState<{ key: string; message: string } | null>(null);
    const [retry, setRetry] = useState(0);
    const [passwords, setPasswords] = useState<typeof import('../pdf/session/passwords') | null>(null);
    const key = identity ? `${reading.identity.vaultEpoch}:${reading.identity.documentId}:${identity.serial}:${identity.bytesGeneration}` : '';
    const source = loaded?.key === key ? loaded.source : null;
    useEffect(() => {
        if (!key) return;
        const controller = new AbortController();
        void Promise.all([import('../pdf/session/sourceRuntime'), import('../pdf/session/passwords')]).then(async ([{ ensurePdfTiledSourceFactory }, store]) => {
            if (!controller.signal.aborted) setPasswords(store);
            const factory = await ensurePdfTiledSourceFactory();
            controller.signal.throwIfAborted();
            if (retry > 0 && identity) {
                const { retryPdfPool } = await import('../pdf/session/startup');
                await retryPdfPool({ vaultEpoch: reading.identity.vaultEpoch, documentId: reading.identity.documentId,
                    bytesGeneration: identity.bytesGeneration, session: identity.serial });
                controller.signal.throwIfAborted();
            }
            return factory.open(reading, controller.signal);
        }).then(value => {
            if (!controller.signal.aborted && value.session.isCurrent() && value.session.token.vaultEpoch === reading.identity.vaultEpoch &&
                value.session.token.documentId === reading.identity.documentId && value.session.token.session === identity?.serial &&
                value.session.token.bytesGeneration === identity.bytesGeneration) { setLoaded({ key, source: value }); setError(null); }
        }, failure => {
            if (!controller.signal.aborted) setError({ key, message: failure instanceof Error ? failure.message : 'PDF could not be opened.' });
        });
        return () => controller.abort();
    }, [reading, identity, key, retry]);
    useEffect(() => {
        if (!key) return;
        let disposed = false;
        let release: (() => void) | undefined;
        void import('../pdf/session/startup').then(({ retainPdfFocus }) => {
            if (disposed) return;
            const lease = retainPdfFocus(reading.identity.documentId);
            lease.setFocused(props.visible && props.focused);
            release = () => lease.dispose();
        });
        return () => { disposed = true; release?.(); };
    }, [key, reading.identity.documentId, props.visible, props.focused]);
    useEffect(() => { if (source?.session.isCurrent()) onSource(source); }, [onSource, source]);
    const passwordPrompt = passwords ? <PdfPasswordCoordinator identity={reading.identity} store={passwords} visible={props.visible && props.focused} /> : null;
    if (error?.key === key && !source) return <>{passwordPrompt}<div className="pdf-pane-message" role="alert">{error.message}
        <button className="pdf-pane-action" onClick={() => { setError(null); setRetry(value => value + 1); }}>Retry</button>
        <button className="pdf-pane-action" onClick={props.openClassic}>Open in Classic</button></div></>;
    if (!source) return <>{passwordPrompt}<div className="pdf-pane-message" role="status">{props.sourceOnly ? 'Opening extracted text…' : 'Loading PDF…'}</div></>;
    if (props.sourceOnly) return null;
    return <PdfTiledView reading={reading} session={source.session} document={source.document}
        mirror={source.mirror} capturer={source.capturer} selectionState={source.selection}
        filePath={props.filePath} isVisible={props.visible} isFocused={props.focused} sourceHash={props.sourceHash}
        findMemory={props.findMemory} onSearchVault={props.searchVault} onRotate={props.rotate}
        onOpenTextView={props.openText} onNotice={props.notify} onOpenClassic={props.openClassic} />;
}
