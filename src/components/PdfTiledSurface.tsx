import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import type { PdfReadingBinding, ReaderCapabilities } from '../types/reading';
import type { PdfFindMemory } from '../utils/pdfFindHighlight';
import type { PdfRotationPicture } from '../utils/pdfRotationPreview';
import { getSessionIdentity, subscribeSessionIdentity } from '../utils/sessionIdentity';
import type { PdfTiledPresentation, PdfTiledSource } from '../pdf/session/hostTypes';
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
    onSource(source: PdfTiledSource): void;
    onPresentation?(presentation: PdfTiledPresentation): void;
    onCapabilities(source: PdfTiledSource, capabilities: ReaderCapabilities): void;
    notify(message: string): void;
}

/** A view can come and go; the factory parks its immutable source in the
 * App-owned document slot, with no extra document or worker on a graph trip. */
export default function PdfTiledSurface(props: Props) {
    const { reading, onSource } = props;
    const identity = useSyncExternalStore(subscribeSessionIdentity,
        () => getSessionIdentity(reading.identity.documentId), () => undefined);
    const [loaded, setLoaded] = useState<{ key: string; source: PdfTiledSource } | null>(null);
    const [version, setVersion] = useState<{ source: PdfTiledSource; hash: string } | null>(null);
    const [error, setError] = useState<{ key: string; message: string } | null>(null);
    const [retry, setRetry] = useState(0);
    const [passwords, setPasswords] = useState<typeof import('../pdf/session/passwords') | null>(null);
    const key = identity ? `${reading.identity.vaultEpoch}:${reading.identity.documentId}:${identity.serial}:${identity.bytesGeneration}` : '';
    const source = loaded?.key === key ? loaded.source : null;
    const onCapabilities = props.onCapabilities;
    const reportCapabilities = useCallback((capabilities: ReaderCapabilities) => {
        if (source?.session.isCurrent()) onCapabilities(source, capabilities);
    }, [source, onCapabilities]);
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
            // An engine failure arrives wrapped in worker-host prefixes; the reader sees only the engine's own sentence.
            if (!controller.signal.aborted) setError({ key, message: failure instanceof Error ? failure.message.replace(/^.*\bEngineBroken: /, '') : 'PDF could not be opened.' });
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
    useEffect(() => {
        if (!source) return;
        let active = true;
        void source.version.then(value => {
            if (active && source.session.isCurrent()) setVersion({ source, hash: value.hash });
        }).catch(() => {});
        return () => { active = false; };
    }, [source]);
    const passwordPrompt = passwords ? <PdfPasswordCoordinator identity={reading.identity} store={passwords} visible={props.visible && props.focused} /> : null;
    if (error?.key === key && !source) return <>{passwordPrompt}<div className="pdf-pane-message" role="alert">{error.message}
        <button className="pdf-pane-action" onClick={() => { setError(null); setRetry(value => value + 1); }}>Retry</button>
        </div></>;
    if (!source) return <>{passwordPrompt}<div className="pdf-pane-message" role="status">{props.sourceOnly ? 'Opening extracted text…' : 'Loading PDF…'}</div></>;
    if (props.sourceOnly) return null;
    return <PdfTiledView reading={reading} session={source.session} document={source.document}
        mirror={source.mirror} capturer={source.capturer} selectionState={source.selection} transition={source.transition} bridge={source.bridge}
        filePath={props.filePath} isVisible={props.visible} isFocused={props.focused} sourceHash={version?.source === source ? version.hash : undefined} onPresentation={props.onPresentation}
        findMemory={props.findMemory} onSearchVault={props.searchVault} onRotate={props.rotate}
        onCapabilities={reportCapabilities}
        onOpenTextView={props.openText} onNotice={props.notify} />;
}
