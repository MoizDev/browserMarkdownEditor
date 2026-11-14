import './printBoard.css';

export interface PrintFallbackPages {
    readonly pages: readonly Blob[];
    readonly total: number;
}
export interface BoardPrintRequest {
    readonly pdf: Blob;
    /** App/session identity and any source revision still valid at the handoff. */
    readonly valid: () => boolean;
    readonly signal: AbortSignal;
    /** 200 dpi, no more than the requested number of pages. */
    readonly renderFallback: (limit: number, signal: AbortSignal) => Promise<PrintFallbackPages>;
    readonly noticeTruncated: (printed: number, total: number) => void;
    readonly onError: (error: unknown) => void;
}

/** Invoke only from the board's Mod-P route. No HTML is built from document contents. */
export async function printBoard(request: BoardPrintRequest): Promise<void> {
    const { pdf, valid, signal } = request;
    signal.throwIfAborted();
    if (!valid()) throw new DOMException('Board session ended', 'AbortError');
    if (navigator.pdfViewerEnabled) {
        const url = URL.createObjectURL(pdf), frame = document.createElement('iframe');
        frame.className = 'board-print-frame';
        frame.setAttribute('aria-hidden', 'true');
        let timer: ReturnType<typeof setTimeout> | undefined;
        let done = false;
        const cleanup = () => {
            if (done) return;
            done = true;
            clearTimeout(timer);
            signal.removeEventListener('abort', cleanup);
            window.removeEventListener('afterprint', cleanup);
            frame.contentWindow?.removeEventListener('afterprint', cleanup);
            frame.remove();
            URL.revokeObjectURL(url);
        };
        try {
            signal.addEventListener('abort', cleanup, { once: true });
            window.addEventListener('afterprint', cleanup, { once: true });
            frame.addEventListener('load', () => {
                if (done) return;
                if (signal.aborted || !valid()) { cleanup(); return; }
                try {
                    const target = frame.contentWindow;
                    if (!target) throw new Error('Print viewer is unavailable');
                    target.addEventListener('afterprint', cleanup, { once: true });
                    target.focus();
                    target.print();
                } catch (error) { cleanup(); request.onError(error); }
            }, { once: true });
            document.body.append(frame);
            timer = setTimeout(cleanup, 60_000);
            frame.src = url;
            if (signal.aborted) cleanup();
        } catch (error) { cleanup(); throw error; }
        return;
    }
    const result = await request.renderFallback(100, signal);
    signal.throwIfAborted();
    if (!valid()) throw new DOMException('Board session ended', 'AbortError');
    if (!result.pages.length || result.pages.length > 100 || result.total < result.pages.length) throw new RangeError('Invalid print page count');
    if (result.total > result.pages.length) request.noticeTruncated(result.pages.length, result.total);
    const container = document.createElement('div'), urls: string[] = [];
    container.className = 'board-print-pages';
    let timer: ReturnType<typeof setTimeout> | undefined, done = false;
    const cleanup = () => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        signal.removeEventListener('abort', cleanup);
        window.removeEventListener('afterprint', cleanup);
        container.remove();
        for (const url of urls) URL.revokeObjectURL(url);
    };
    try {
        signal.addEventListener('abort', cleanup, { once: true });
        window.addEventListener('afterprint', cleanup, { once: true });
        const loaded = result.pages.map(blob => new Promise<void>((resolve, reject) => {
            const url = URL.createObjectURL(blob), image = document.createElement('img');
            urls.push(url);
            image.alt = '';
            const abort = () => finish(signal.reason ?? new DOMException('Aborted', 'AbortError'));
            const finish = (error?: unknown) => {
                signal.removeEventListener('abort', abort);
                image.onload = null;
                image.onerror = null;
                if (error) reject(error); else resolve();
            };
            signal.addEventListener('abort', abort, { once: true });
            image.onload = () => finish();
            image.onerror = () => finish(new Error('Could not load a print page'));
            image.src = url;
            if (signal.aborted) abort();
            container.append(image);
        }));
        document.body.append(container);
        await Promise.all(loaded);
        signal.throwIfAborted();
        if (!valid()) throw new DOMException('Board session ended', 'AbortError');
        timer = setTimeout(cleanup, 60_000);
        window.print();
    } catch (error) { cleanup(); throw error; }
}
