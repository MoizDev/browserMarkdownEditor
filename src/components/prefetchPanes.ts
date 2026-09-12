// Warm the heavy panes before they are clicked.
//
// A PDF, a drawing and a notebook each live behind `React.lazy`, which is what
// keeps pdf.js (~450kB) and tldraw (~1.7MB) out of a markdown-only session's
// bundle. The cost of that is paid on the FIRST click: measured at ~0.8s for a
// PDF and ~1.2s for a drawing, nearly all of it fetching and parsing the chunk
// rather than doing anything with the document.
//
// So fetch them while nothing is happening instead. Two rules keep this from
// undoing the split it is built on top of:
//
//   · ONLY WHAT THE VAULT ACTUALLY CONTAINS. A vault of pure markdown fetches
//     nothing, which is the case the code splitting exists for. Opening a vault
//     with one `.pdf` in it warms pdf.js and leaves tldraw alone.
//   · ONLY WHEN IDLE, and never before the app has drawn. `requestIdleCallback`
//     yields to anything the reader is doing; this is a nice-to-have that must
//     never compete with a keystroke.
//
// The import specifiers must match the ones `EditorPane`/`DocumentPane` use, or
// the bundler emits a second copy of each chunk instead of warming theirs.

export interface CanvasKinds {
    pdf: boolean;
    drawing: boolean;
    notebook: boolean;
}

/** Each chunk is fetched at most once per session, whatever asks for it. */
const started = new Set<string>();

function warm(key: string, load: () => Promise<unknown>): void {
    if (started.has(key)) return;
    started.add(key);
    // A failed prefetch is not an error the reader should ever see: the real
    // import on click will surface anything that actually matters.
    load().catch(() => started.delete(key));
}

/**
 * Fetch the chunks this vault will need, once the browser is idle.
 *
 * Safe to call repeatedly — on every tree refresh, say. Each chunk is warmed
 * once, and a vault holding none of these kinds does nothing at all.
 */
export function prefetchPanes(kinds: CanvasKinds): void {
    if (!kinds.pdf && !kinds.drawing && !kinds.notebook) return;

    const run = () => {
        // PdfPane pulls pdf.js; the annotate canvas and its tldraw are left for
        // the moment someone actually annotates, since reading is the common case.
        // Starting the shared worker here too takes the ~1MB worker boot off the
        // first click — dynamically, or pdf.js would land in the main bundle.
        if (kinds.pdf) {
            warm('pdf', () => import('./PdfPane'));
            warm('pdf-worker', () => import('../utils/pdfWorker').then(m => { m.pdfWorker(); }));
        }
        // A notebook IS a tldraw canvas, so either kind warms the big one.
        if (kinds.drawing) warm('drawing', () => import('./DrawingPane'));
        if (kinds.notebook) warm('notebook', () => import('./NotebookPane'));
    };

    const idle = (window as unknown as {
        requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number;
    }).requestIdleCallback;
    // Safari has no requestIdleCallback; a timeout is a fine stand-in for
    // something whose only requirement is "not right now".
    if (idle) idle(run, { timeout: 4000 });
    else setTimeout(run, 1500);
}
