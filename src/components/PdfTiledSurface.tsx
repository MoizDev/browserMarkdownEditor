import { useEffect, useState, useSyncExternalStore } from 'react';
import type { PdfReadingBinding } from '../types/reading';
import type { PdfFindMemory } from '../utils/pdfFindHighlight';
import type { PdfRotationPicture } from '../utils/pdfRotationPreview';
import { getSessionIdentity, subscribeSessionIdentity } from '../utils/sessionIdentity';
import type { PdfTiledSource, PdfTiledSourceFactory } from './PdfTiledView';
import PdfTiledView from './PdfTiledView';

interface Props {
    reading: PdfReadingBinding;
    filePath: string;
    visible: boolean;
    focused: boolean;
    sourceHash?: string;
    findMemory: PdfFindMemory;
    searchVault(query: string): void;
    rotate(delta: number, page?: number, picture?: PdfRotationPicture): void;
    openText(page?: number): void;
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
    const [error, setError] = useState<string | null>(null);
    const [retry, setRetry] = useState(0);
    const key = identity ? `${reading.identity.vaultEpoch}:${reading.identity.documentId}:${identity.serial}:${identity.bytesGeneration}` : '';
    const source = loaded?.key === key ? loaded.source : null;
    useEffect(() => {
        if (!key) return;
        const controller = new AbortController();
        void import('../pdf/session/sourceRuntime').then(({ getPdfTiledSourceFactory }) => {
            const factory: PdfTiledSourceFactory | undefined = getPdfTiledSourceFactory();
            if (!factory) throw new Error('The new PDF engine is unavailable. Retry or choose Classic in settings.');
            return factory.open(reading, controller.signal);
        }).then(value => {
            if (!controller.signal.aborted) { setLoaded({ key, source: value }); setError(null); }
        }, failure => {
            if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : 'PDF could not be opened.');
        });
        return () => controller.abort();
    }, [reading, key, retry]);
    useEffect(() => { if (source) onSource(source); }, [onSource, source]);
    if (error && !source) return <div className="pdf-pane-message" role="alert">{error}
        <button className="pdf-pane-action" onClick={() => { setError(null); setRetry(value => value + 1); }}>Retry</button></div>;
    if (!source) return <div className="pdf-pane-message" role="status">Loading PDF…</div>;
    return <PdfTiledView reading={reading} session={source.session} document={source.document}
        mirror={source.mirror} capturer={source.capturer} selectionState={source.selection}
        filePath={props.filePath} isVisible={props.visible} isFocused={props.focused} sourceHash={props.sourceHash}
        findMemory={props.findMemory} onSearchVault={props.searchVault} onRotate={props.rotate}
        onOpenTextView={props.openText} onNotice={props.notify} />;
}
