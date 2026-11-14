export interface BoardPrintSource {
    /** Must use one synchronously pinned export revision. */
    pdf(signal: AbortSignal): Promise<Blob>;
    readonly pageCount: number;
    /** Fallback pages are rendered from that same pin at 200 dpi. */
    pngPage(page: number, signal: AbortSignal): Promise<Blob>;
    release(): void;
}
export interface BoardPrintOptions {
    pin(): BoardPrintSource;
    signal: AbortSignal;
    notice(message: string): void;
}

/** The caller cancels its signal on pane hide, close, another export, or vault switch. */
export async function printBoard(options: BoardPrintOptions): Promise<void> {
    options.signal.throwIfAborted();
    const source = options.pin();
    const urls: string[] = [], nodes: Element[] = [];
    let finished = false, timer: ReturnType<typeof setTimeout> | undefined;
    const cleanup = () => {
        if (finished) return;
        finished = true;
        if (timer !== undefined) clearTimeout(timer);
        window.removeEventListener('afterprint', cleanup);
        options.signal.removeEventListener('abort', cleanup);
        for (const node of nodes) node.remove();
        for (const url of urls) URL.revokeObjectURL(url);
        source.release();
    };
    const urlFor = (blob: Blob): string => { const url = URL.createObjectURL(blob); urls.push(url); return url; };
    options.signal.addEventListener('abort', cleanup, { once: true });
    try {
        if (!Number.isSafeInteger(source.pageCount) || source.pageCount < 1) throw new RangeError('Nothing to print');
        if (navigator.pdfViewerEnabled) {
            const pdf = await source.pdf(options.signal);
            options.signal.throwIfAborted();
            if (pdf.type !== 'application/pdf') throw new TypeError('Invalid print PDF');
            const frame = document.createElement('iframe');
            frame.setAttribute('aria-hidden', 'true');
            Object.assign(frame.style, { position: 'fixed', width: '1px', height: '1px', left: '-10000px', border: '0' });
            nodes.push(frame);
            await new Promise<void>((resolve, reject) => {
                const abort = () => reject(options.signal.reason ?? new DOMException('Print cancelled', 'AbortError'));
                frame.addEventListener('load', () => { options.signal.removeEventListener('abort', abort); resolve(); }, { once: true });
                frame.addEventListener('error', () => { options.signal.removeEventListener('abort', abort); reject(new Error('Print PDF could not be opened')); }, { once: true });
                options.signal.addEventListener('abort', abort, { once: true });
                frame.src = urlFor(pdf);
                document.body.appendChild(frame);
                if (options.signal.aborted) abort();
            });
            options.signal.throwIfAborted();
            window.addEventListener('afterprint', cleanup, { once: true });
            frame.contentWindow?.addEventListener('afterprint', cleanup, { once: true });
            timer = setTimeout(cleanup, 60_000);
            if (!frame.contentWindow) throw new Error('Print PDF viewer unavailable');
            frame.contentWindow.focus(); frame.contentWindow.print();
        } else {
            const count = Math.min(source.pageCount, 100);
            if (count < source.pageCount) options.notice(`Printing 100 of ${source.pageCount} pages; export to PDF to print all`);
            const container = document.createElement('div');
            container.className = 'wb-print-pages';
            const style = document.createElement('style');
            style.textContent = '@media screen {.wb-print-pages{display:none}} @media print {body>*:not(.wb-print-pages){display:none!important}.wb-print-pages img{display:block;width:100%;height:auto;break-after:page}.wb-print-pages img:last-child{break-after:auto}}';
            nodes.push(container, style);
            for (let page = 0; page < count; page++) {
                options.signal.throwIfAborted();
                const png = await source.pngPage(page, options.signal);
                options.signal.throwIfAborted();
                if (png.type !== 'image/png') throw new TypeError('Invalid print page');
                const image = document.createElement('img'); image.alt = `Page ${page + 1}`; image.src = urlFor(png);
                container.appendChild(image);
            }
            document.head.appendChild(style); document.body.appendChild(container);
            await Promise.all(Array.from(container.querySelectorAll('img'), image => image.decode()));
            options.signal.throwIfAborted();
            window.addEventListener('afterprint', cleanup, { once: true });
            timer = setTimeout(cleanup, 60_000);
            window.print();
        }
    } catch (error) { cleanup(); throw error; }
}
