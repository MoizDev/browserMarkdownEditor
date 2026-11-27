import type { CanvasOp } from '../../shared/vaultAgentProtocol';

export type ViewKind = 'epub' | 'markdown' | 'pdf' | 'pdf-annotate' | 'drawing' | 'notebook';

export interface LineCol {
    line: number;
    col: number;
}

export interface MarkdownViewInfo {
    kind: 'markdown';
    mode: 'read' | 'edit';
    text: string;
    lineCount: number;
    visibleLines: { from: number; to: number };
    visibleRange: { from: number; to: number };
    cursor: LineCol;
    cursorOffset: number;
    selections: Array<{ from: number; to: number; fromLC: LineCol; toLC: LineCol }>;
    dirty: boolean;
    language?: string;
}

export interface PdfViewInfo {
    kind: 'pdf' | 'pdf-annotate';
    surface: 'original' | 'text' | 'annotation';
    textAnchor?: import('../types/reading').PdfTextAnchor;
    visibleCanonicalText?: string;
    pageCount: number;
    page: number;
    offset: number;
    zoom: number;
    visiblePages: number[];
    selectedText: string | null;
    inverted: boolean;
    shapes?: ShapeSummary[];
    shapesTotal?: number;
    selectedShapeIds?: string[];
}

export interface DrawingViewInfo {
    kind: 'drawing';
    pageName: string;
    pageIndex: number;
    pageCount: number;
    camera: { x: number; y: number; z: number };
    viewport: { x: number; y: number; w: number; h: number };
    selectedShapeIds: string[];
    shapes: ShapeSummary[];
    shapesTotal: number;
}

export interface NotebookViewInfo {
    kind: 'notebook';
    pageCount: number;
    page: number;
    offset: number;
    zoom: number;
    visiblePages: number[];
    paper: string | null;
    selectedShapeIds: string[];
    shapes: ShapeSummary[];
    shapesTotal: number;
}

export interface EpubViewInfo {
    kind:'epub'; status:import('../types/reading').ReaderStatus['phase']; title?:string; author?:string;
    locator?:import('../types/reading').EpubLocator; flow?:import('../types/reading').ReaderFlow;
    capabilities?:import('../types/reading').ReaderCapabilities;
    visibleCanonicalText:string; selectedCanonicalText:string|null;
}
export type ViewInfo = EpubViewInfo | MarkdownViewInfo | PdfViewInfo | DrawingViewInfo | NotebookViewInfo;

export interface ShapeSummary {
    id: string;
    type: string;
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
    startShapeId?: string;
    endShapeId?: string;
}

export interface CanvasApplyResult {
    created: string[];
    updated: string[];
    deleted: string[];
    updatedShapes?: readonly ShapeSummary[];
    errors: string[];
}

export interface CanvasShapeQuery {
    page?: number;
    offset?: number;
    limit?: number;
    revision?: number;
}
export interface CanvasShapePage {
    shapes: ShapeSummary[];
    total: number;
    revision: number;
    nextOffset?: number;
    revisionChanged?: true;
    sections?: readonly { readonly offset: number; readonly name: string; readonly index: number }[];
}

export interface CanvasAgentOps {
    shapes(page?: number): ShapeSummary[];
    shapePage?(query?: CanvasShapeQuery): CanvasShapePage;
    apply(ops: CanvasOp[], guard?: { readonly signal?: AbortSignal; isCurrent(): boolean }): CanvasApplyResult | Promise<CanvasApplyResult>;
    currentPage(): number;
}

export interface TextChange {
    from: number;
    to: number;
    insert: string;
}

export interface LiveJob {
    readonly signal?: AbortSignal;
    readonly deadlineMs: number;
}

export interface NativeLiveView {
    measured(): boolean;
    describe(job: LiveJob): Promise<DrawingViewInfo | NotebookViewInfo | PdfViewInfo>;
    capture(maxSide: number, job: LiveJob): Promise<Blob>;
    renderPage(page: number, maxSide: number, job: LiveJob): Promise<Blob>;
}

export interface ViewReporter {
    kind: ViewKind;
    describe(): ViewInfo | Promise<ViewInfo>;
    live?: NativeLiveView;
    capture?(maxSide: number): Promise<Blob | null>;
    pdfText?(pages: number[], signal?: AbortSignal): Promise<Array<{ page: number; text: string; quality?: 'partial'; warnings?: readonly string[] }>>;
    renderPage?(page: number, maxSide: number): Promise<Blob | null>;
    renderPageWithInfo?(page: number, maxSide: number): Promise<{ png: Blob; emphasis?: import('../types/vaultAgent').ClosedPdfEmphasis }>;
    applyTextChanges?(changes: TextChange[]): boolean;
    getText?(): string;
    canvas?: CanvasAgentOps;
    replaceFromDisk?(text: string): boolean;
    hasPendingEdits?(): boolean;
    flushPending?(): void | Promise<void>;
}

const views = new Map<string, ViewReporter>();
const waiters = new Map<string, Set<(reporter: ViewReporter) => void>>();

export function registerView(path: string, reporter: ViewReporter): () => void {
    views.set(path, reporter);
    const pending = waiters.get(path);
    if (pending) {
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

export function allViews(): ReadonlyMap<string, ViewReporter> {
    return views;
}

export function moveView(from: string, to: string): void {
    const reporter = views.get(from);
    if (!reporter) return;
    views.delete(from);
    views.set(to, reporter);
}

export function clearViews(): void {
    views.clear();
}

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
