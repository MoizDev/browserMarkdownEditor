import { useEffect, useLayoutEffect, useRef, useState } from 'react';

type PageRect = Readonly<{ x: number; y: number; width: number; height: number }>;

interface NativeNotebookThumbnailsBaseProps {
    readonly pages: readonly PageRect[];
    readonly revision: number;
    readonly page: number;
    readonly isVisible: boolean;
    current(): boolean;
    currentRevision(): number;
    capturePng(rect: PageRect, maxSide: number, signal: AbortSignal): Promise<Blob>;
    jump(page: number): void;
    onError(error: unknown): void;
    /** Moves page `from` so it ends at index `to`. Absent when the view cannot write. */
    reorder?(from: number, to: number): void;
}
export type NativeNotebookThumbnailsProps = NativeNotebookThumbnailsBaseProps & (
    | { readonly open: boolean; readonly onOpenChange: (open: boolean) => void }
    | { readonly open?: undefined; readonly onOpenChange?: never }
);

const WINDOW = 6;
type Image = { readonly page: number; readonly revision: number; readonly url: string };

/** Captures only the displayed page window, one pinned source at a time. */
export default function NativeNotebookThumbnails(props: NativeNotebookThumbnailsProps) {
    const { pages, revision, page, isVisible, current, currentRevision, capturePng, jump, onError, reorder } = props;
    const [ownOpen, setOwnOpen] = useState(false), [offset, setOffset] = useState(0);
    const controlled = props.open !== undefined, open = props.open ?? ownOpen;
    const setOpen = (value: boolean) => { if (controlled) props.onOpenChange(value); else setOwnOpen(value); };
    const pageRef = useRef(page); pageRef.current = page;
    const [images, setImages] = useState<readonly Image[]>([]), [failed, setFailed] = useState(false);
    useLayoutEffect(() => { if (open) setOffset(Math.floor(pageRef.current / WINDOW) * WINDOW); }, [open]);
    const start = Math.max(0, Math.min(offset, Math.max(0, pages.length - WINDOW)));
    useEffect(() => {
        if (!open || !isVisible || !current() || currentRevision() !== revision) { setImages([]); return; }
        const controller = new AbortController(), urls: string[] = [];
        setImages([]); setFailed(false);
        void (async () => {
            for (let index = start; index < Math.min(pages.length, start + WINDOW); index++) {
                try {
                    const blob = await capturePng(pages[index], 192, controller.signal);
                    if (controller.signal.aborted || !current() || currentRevision() !== revision) return;
                    const url = URL.createObjectURL(blob); urls.push(url);
                    setImages(previous => [...previous, { page: index, revision, url }]);
                } catch (error) {
                    if (controller.signal.aborted || !current() || currentRevision() !== revision) return;
                    setFailed(true); onError(error);
                }
            }
        })();
        return () => { controller.abort(); for (const url of urls) URL.revokeObjectURL(url); };
    }, [open, isVisible, current, currentRevision, capturePng, pages, revision, start, onError]);
    if (!isVisible) return null;
    return <>
        {!controlled && <button type="button" aria-expanded={open} onClick={() => {
            if (!open) setOffset(Math.floor(page / WINDOW) * WINDOW);
            setOpen(!open);
        }}>Thumbnails</button>}
        {open && <div className="native-notebook-thumbnails" role="region" aria-label="Notebook page thumbnails"
            style={{ position: 'absolute', top: '100%', right: 0, maxHeight: 'min(70vh, 600px)', overflowY: 'auto',
                display: 'grid', gap: 6, padding: 8, background: 'var(--background-secondary)',
                border: '1px solid var(--background-modifier-border)', borderRadius: 6 }}>
            <div><button type="button" disabled={start === 0} onClick={() => setOffset(Math.max(0, start - WINDOW))}>Previous pages</button>{' '}
                <button type="button" disabled={start + WINDOW >= pages.length} onClick={() => setOffset(start + WINDOW)}>Next pages</button>{' '}
                {controlled && <button type="button" onClick={() => setOpen(false)}>Close thumbnails</button>}</div>
            {Array.from({ length: Math.min(WINDOW, pages.length - start) }, (_, index) => {
                const number = start + index, image = images.find(item => item.page === number && item.revision === revision);
                return <div key={number} style={{ display: 'grid', justifyItems: 'center', gap: 4 }}>
                    <button type="button" aria-label={`Go to page ${number + 1}`}
                        aria-current={page === number ? 'page' : undefined} onClick={() => { if (current()) jump(number); }}
                        style={{ display: 'grid', justifyItems: 'center', gap: 4 }}>
                        {image ? <img src={image.url} alt="" draggable={false} style={{ maxWidth: 160, maxHeight: 192 }} />
                            : <span>{failed ? 'Preview unavailable' : 'Preparing preview…'}</span>}
                        <span>Page {number + 1}</span>
                    </button>
                    {reorder && <div role="group" aria-label={`Reorder page ${number + 1}`}>
                        <button type="button" disabled={number === 0} aria-label={`Move page ${number + 1} earlier`}
                            onClick={() => reorder(number, number - 1)}>Earlier</button>{' '}
                        <button type="button" disabled={number >= pages.length - 1} aria-label={`Move page ${number + 1} later`}
                            onClick={() => reorder(number, number + 1)}>Later</button>
                    </div>}
                </div>;
            })}
        </div>}
    </>;
}
