// What the user is looking at, right now, in every mounted pane — the source of
// the AI agent's context and the handle its tools act through.
//
// Every mounted document pane registers a reporter under its path; the agent
// panel asks them at SEND time (never on a timer), so the context is always
// the live position, not a stored one. Nothing here is persisted.
//
// A plain path-keyed map with NO heavy imports, like pdfRenderCache.ts: App and
// the agent panel reach it on every message, and the reporters themselves live
// in the lazy pdf/tldraw chunks. A path is open in exactly one pane (tabs are
// unique per path), so the key is the path.

import type { CanvasOp } from '../../shared/vaultAgentProtocol';

export type ViewKind = 'markdown' | 'pdf' | 'pdf-annotate' | 'drawing' | 'notebook';

/** 1-based line and column (column counts UTF-16 units, like CodeMirror). */
export interface LineCol {
    line: number;
    col: number;
}

export interface MarkdownViewInfo {
    kind: 'markdown';
    mode: 'read' | 'edit';
    /** The live text, unsaved edits included. */
    text: string;
    lineCount: number;
    /** The lines on screen, 1-based inclusive. */
    visibleLines: { from: number; to: number };
    /** The same, as offsets into `text` (from the line starts/ends). */
    visibleRange: { from: number; to: number };
    /** Main cursor (selection head). */
    cursor: LineCol;
    cursorOffset: number;
    /** Non-empty selections only, in document order. */
    selections: Array<{ from: number; to: number; fromLC: LineCol; toLC: LineCol }>;
    /** Has edits not yet written to disk. */
    dirty: boolean;
    /** Set on a source file: the language its pane is highlighting ("Python",
     *  "Racket"). The agent is told, so it edits in the right one without
     *  guessing from the extension — and so a `.rkt` is called Racket even
     *  though a Scheme grammar is what colours it. */
    language?: string;
}

export interface PdfViewInfo {
    kind: 'pdf' | 'pdf-annotate';
    pageCount: number;
    /** 1-based page under the top edge of the view. */
    page: number;
    /** How far into `page` the top edge sits, 0..1. */
    offset: number;
    /** Zoom on top of fit-width (1 = fit width). */
    zoom: number;
    /** 1-based pages at least partly on screen. */
    visiblePages: number[];
    /** Text the user has selected in the page text layer, if any. */
    selectedText: string | null;
    /** The reader's dark-mode page inversion is on. */
    inverted: boolean;
    /** pdf-annotate only: annotation shapes on the visible pages (page-relative). */
    shapes?: ShapeSummary[];
    shapesTotal?: number;
    selectedShapeIds?: string[];
}

export interface DrawingViewInfo {
    kind: 'drawing';
    /** tldraw page (a drawing may hold several). */
    pageName: string;
    pageIndex: number;
    pageCount: number;
    camera: { x: number; y: number; z: number };
    /** The part of the canvas on screen, in canvas coordinates. */
    viewport: { x: number; y: number; w: number; h: number };
    selectedShapeIds: string[];
    /** Shapes at least partly in the viewport, capped (see shapesTotal). */
    shapes: ShapeSummary[];
    /** How many shapes are in the viewport in all (≥ shapes.length). */
    shapesTotal: number;
}

export interface NotebookViewInfo {
    kind: 'notebook';
    pageCount: number;
    /** 1-based page under the top edge of the view. */
    page: number;
    offset: number;
    zoom: number;
    visiblePages: number[];
    /** Ruled / squared / plain, as the notebook stores it. */
    paper: string | null;
    selectedShapeIds: string[];
    /** Shapes on the visible pages, page-relative coordinates. */
    shapes: ShapeSummary[];
    shapesTotal: number;
}

export type ViewInfo = MarkdownViewInfo | PdfViewInfo | DrawingViewInfo | NotebookViewInfo;

/** One shape as the agent sees it. On notebooks and PDF annotation layers `x`/`y`
 *  are page-relative (from `page`'s top-left, in page units); on drawings they
 *  are canvas coordinates and `page` is absent. */
export interface ShapeSummary {
    id: string;
    /** tldraw shape type: geo, text, note, arrow, line, draw, image, … */
    type: string;
    /** For geo shapes: rectangle, ellipse, … */
    geo?: string;
    page?: number;
    x: number;
    y: number;
    w: number;
    h: number;
    rotation?: number;
    text?: string;
    color?: string;
    fill?: string;
    dash?: string;
    size?: string;
    /** Arrows: what each end is bound to, if anything. */
    startShapeId?: string;
    endShapeId?: string;
}

export interface CanvasApplyResult {
    created: string[];
    updated: string[];
    deleted: string[];
    /** One message per op that was skipped, e.g. "op 3: no shape shape:abc". */
    errors: string[];
}

/** The agent's hands on a tldraw-based document (drawing, notebook, PDF annotate). */
export interface CanvasAgentOps {
    /** Every shape (or one page's), with full style. */
    shapes(page?: number): ShapeSummary[];
    /** Apply ops as ONE undo step, saved exactly as a user edit is. A shape id
     *  may be written with or without its `shape:` prefix, and `$N` names the
     *  shape op N (1-based) of the same batch created — so one call can draw
     *  two boxes and the arrow between them. Page backdrops and locked shapes
     *  are refused per op. `errors` also carries `op N: note: …` lines for ops
     *  that applied with an adjustment (a point moved onto the page). */
    apply(ops: CanvasOp[]): CanvasApplyResult;
    /** 1-based page the user is on (default target for ops without `page`). */
    currentPage(): number;
}

export interface TextChange {
    from: number;
    to: number;
    insert: string;
}

export interface ViewReporter {
    kind: ViewKind;
    /** Where the user is, now. Cheap enough to call once per message. */
    describe(): ViewInfo | Promise<ViewInfo>;
    /** A PNG of what is on screen, long side ≤ maxSide px. Canvases and PDFs only. */
    capture?(maxSide: number): Promise<Blob | null>;
    /** PDF text of the given 1-based pages from the loaded document. */
    pdfText?(pages: number[]): Promise<Array<{ page: number; text: string }>>;
    /** A PNG of one 1-based page (PDF / notebook), long side ≤ maxSide. */
    renderPage?(page: number, maxSide: number): Promise<Blob | null>;
    /** Markdown: dispatch changes into the live editor as one undoable
     *  transaction (`userEvent: 'input.agent'`, isolated in the history), in
     *  reading mode too. Offsets are into the CURRENT text. False if the view
     *  is gone; throws RangeError on out-of-bounds or overlapping ranges.
     *  Absent for the Help Guide, which is never editable. */
    applyTextChanges?(changes: TextChange[]): boolean;
    /** Markdown: the live text. */
    getText?(): string;
    canvas?: CanvasAgentOps;
    // ── outside-change handling (App.checkOpenDocs). The agent never calls these.
    /** Text documents: put the file's new text from disk into the live editor
     *  as one minimal, history-isolated transaction annotated `externalReload`,
     *  so the pane reports it WITHOUT marking the tab dirty. False if the view
     *  is gone (App then updates the cached state and the buffer itself). */
    replaceFromDisk?(text: string): boolean;
    /** Canvases: edits the pane holds that App cannot see yet — a drawing or
     *  notebook's 400 ms store debounce, an annotated PDF's unsaved strokes.
     *  A document with pending edits is never reloaded over: it is a conflict. */
    hasPendingEdits?(): boolean;
    /** Canvases: push those pending edits into the save funnel NOW, so a
     *  conflict's "Reload" can keep them as the `(conflict)` copy. */
    flushPending?(): void | Promise<void>;
}

const views = new Map<string, ViewReporter>();
const waiters = new Map<string, Set<(reporter: ViewReporter) => void>>();

/** Register `reporter` for `path`; returns the unregister function. Only removes
 *  its own registration, so a remount that registers before the old pane's
 *  cleanup runs is not undone by it — and removes it WHEREVER it now is: a
 *  rename `moveView`s the old pane's reporter to the new path before that pane
 *  unmounts (every pane is keyed by its path, so a rename remounts it), and a
 *  removal keyed on the old path would leave a dead reporter answering for the
 *  new one until the new pane registered. */
export function registerView(path: string, reporter: ViewReporter): () => void {
    views.set(path, reporter);
    const pending = waiters.get(path);
    if (pending) {
        // Each waiter either resolves or re-adds itself (see whenViewReady), so
        // hand them a fresh bucket to re-add into.
        const run = [...pending];
        pending.clear();
        for (const notify of run) notify(reporter);
        if (pending.size === 0) waiters.delete(path);
    }
    return () => {
        if (views.get(path) === reporter) { views.delete(path); return; }
        for (const [key, value] of views) {
            if (value === reporter) views.delete(key);
        }
    };
}

export function getView(path: string): ViewReporter | undefined {
    return views.get(path);
}

/** Every registered view, path → reporter. */
export function allViews(): ReadonlyMap<string, ViewReporter> {
    return views;
}

/** A rename/move carried the document to a new path (App.retargetTabs). */
export function moveView(from: string, to: string): void {
    const reporter = views.get(from);
    if (!reporter) return;
    views.delete(from);
    views.set(to, reporter);
}

/** Vault switch: nothing registered belongs to the new vault. */
export function clearViews(): void {
    views.clear();
}

/** Resolve with `path`'s reporter once one registers that `accept`s (at once if
 *  the current one does), or null after `timeoutMs`. `accept` lets a caller wait
 *  past a reporter of the wrong kind — a PDF's reader view while it switches to
 *  annotate, which is the one with `canvas`. */
export function whenViewReady(
    path: string,
    timeoutMs: number,
    accept: (reporter: ViewReporter) => boolean = () => true,
): Promise<ViewReporter | null> {
    const now = views.get(path);
    if (now && accept(now)) return Promise.resolve(now);
    return new Promise(resolve => {
        let set = waiters.get(path);
        if (!set) waiters.set(path, (set = new Set()));
        const bucket = set;
        const done = (reporter: ViewReporter) => {
            if (!accept(reporter)) { bucket.add(done); return; }
            clearTimeout(timer);
            resolve(reporter);
        };
        bucket.add(done);
        const timer = setTimeout(() => {
            bucket.delete(done);
            if (bucket.size === 0 && waiters.get(path) === bucket) waiters.delete(path);
            resolve(null);
        }, timeoutMs);
    });
}
