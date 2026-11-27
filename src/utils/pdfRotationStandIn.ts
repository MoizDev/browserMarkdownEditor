export interface PdfStandInFrame {
    readonly canvas: HTMLCanvasElement;
    readonly left: number; readonly top: number; readonly width: number; readonly height: number;
}
export interface PdfPagePicture {
    readonly image: HTMLCanvasElement;
    readonly turns: number;
    readonly top?: HTMLCanvasElement;
    readonly whole?: boolean;
}
export interface PdfTurns { readonly all: number; readonly pages: ReadonlyMap<number, number> }
export type PdfRotationOutcome =
    | { kind: 'written'; hash: string; from: number; to: number; turns: PdfTurns }
    | { kind: 'unchanged' } | { kind: 'failed' };

interface DocumentState {
    readonly total: Uint8Array;
    readonly applied: Map<number, Uint8Array>;
    readonly pictures: Map<number, PdfPagePicture>;
    readonly frames: Map<Element, PdfStandInFrame>;
    pending: number;
    lastHash?: string;
    expectedHash?: string;
    readonly restore: () => void;
    version: number;
    drawn: number;
}

let turnSerial = 0;
const STAND_IN_LIMIT_MS = 10_000;
const states = new Map<string, DocumentState>();
const listeners = new Set<() => void>();
function emit(): void { for (const listener of [...listeners]) { try { listener(); } catch { /* One observer cannot stop the others. */ } } }
const mod4 = (value: number) => ((value % 4) + 4) % 4;

export function subscribePdfRotationStandIn(listener: () => void): () => void {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
}

export function pdfRotationVersion(documentId: string): number { return states.get(documentId)?.version ?? 0; }
export function pdfRotationDrawSerial(documentId: string): number { return states.get(documentId)?.drawn ?? 0; }
export function pdfRotationActive(documentId: string): boolean { return states.has(documentId); }
export function pdfStandInFrame(documentId: string, pane: Element | null): PdfStandInFrame | undefined {
    return pane ? states.get(documentId)?.frames.get(pane) : undefined;
}
export function pdfRotationHasPicture(documentId: string, page: number): boolean { return !!states.get(documentId)?.pictures.has(page); }
export function pdfRotationWantsBackdrop(documentId: string, page: number): boolean {
    const state = states.get(documentId);
    return !!state && !state.pictures.get(page)?.whole;
}

export function addPdfRotationBackdrop(documentId: string, page: number, backdrop: ImageBitmap, turns: number): void {
    const state = states.get(documentId);
    if (!state || page < 0 || page >= state.total.length) return;
    const existing = state.pictures.get(page);
    if (existing?.whole) return;
    const quarter = existing ? mod4(existing.turns - turns) : 0;
    const canvas = document.createElement('canvas');
    canvas.width = existing ? existing.image.width : backdrop.width; canvas.height = existing ? existing.image.height : backdrop.height;
    const context = canvas.getContext('2d');
    if (!context) return;
    context.translate(canvas.width / 2, canvas.height / 2);
    context.rotate(quarter * Math.PI / 2);
    const [w, h] = quarter % 2 ? [canvas.height, canvas.width] : [canvas.width, canvas.height];
    context.drawImage(backdrop, -w / 2, -h / 2, w, h);
    context.setTransform(1, 0, 0, 1, 0, 0);
    if (existing) {
        context.drawImage(existing.top ?? existing.image, 0, 0);
        release(existing.image);
        if (existing.top) release(existing.top);
    }
    state.pictures.set(page, { image: canvas, turns: existing ? existing.turns : turns, whole: true });
    state.drawn = ++turnSerial;
    state.version++;
    emit();
}

export function pdfRotationView(documentId: string, generation: number, pageCount: number):
    { pending(page: number): number; shown(page: number): number; picture(page: number): { image: HTMLCanvasElement; quarter: number } | undefined } | undefined {
    const state = states.get(documentId), applied = state?.applied.get(generation);
    if (!state || !applied || state.total.length !== pageCount) return undefined;
    return {
        pending: page => mod4(state.total[page] - applied[page]),
        shown: page => applied[page],
        picture: page => {
            const picture = state.pictures.get(page);
            return picture && { image: picture.image, quarter: mod4(state.total[page] - picture.turns) };
        },
    };
}

export function beginPdfRotationTurn(documentId: string, options: {
    generation: number; pageCount: number; delta: number; page?: number;
    capture(applied: (page: number) => number): ReadonlyMap<number, PdfPagePicture>; restore: () => void;
}): void {
    let state = states.get(documentId);
    if (!state || state.total.length !== options.pageCount || !state.applied.has(options.generation)) {
        if (state) dispose(state);
        state = { total: new Uint8Array(options.pageCount), applied: new Map([[options.generation, new Uint8Array(options.pageCount)]]),
            pictures: new Map(), frames: new Map(), pending: 0, restore: options.restore, version: 0, drawn: 0 };
        states.set(documentId, state);
    }
    const live = state, applied = live.applied.get(options.generation)!;
    for (const [page, picture] of options.capture(page => applied[page])) live.pictures.set(page, picture);
    const quarter = mod4(options.delta / 90);
    if (options.page === undefined) for (let i = 0; i < live.total.length; i++) live.total[i] = mod4(live.total[i] + quarter);
    else if (options.page >= 0 && options.page < live.total.length) live.total[options.page] = mod4(live.total[options.page] + quarter);
    live.pending++;
    live.expectedHash = undefined;
    live.drawn = ++turnSerial;
    live.version++;
    emit();
}

export function setPdfStandInFrame(documentId: string, pane: Element, frame: PdfStandInFrame): void {
    const state = states.get(documentId);
    if (!state) { release(frame.canvas); return; }
    const old = state.frames.get(pane);
    if (old && old.canvas !== frame.canvas) release(old.canvas);
    state.frames.set(pane, frame);
    state.version++;
    emit();
}

export function dropPdfStandInFrame(documentId: string, pane: Element): void {
    const state = states.get(documentId), frame = state?.frames.get(pane);
    if (!state || !frame) return;
    release(frame.canvas);
    state.frames.delete(pane);
    if (!state.pending && !state.frames.size) { clear(documentId); return; }
    state.version++;
    emit();
}

export function settlePdfRotationWrite(documentId: string, outcome: PdfRotationOutcome, presses: number): void {
    const state = states.get(documentId);
    if (!state) return;
    if (outcome.kind === 'failed') {
        state.restore();
        clear(documentId);
        return;
    }
    if (outcome.kind === 'written') {
        const from = state.applied.get(outcome.from) ?? new Uint8Array(state.total.length), to = new Uint8Array(state.total.length);
        for (let i = 0; i < to.length; i++) to[i] = mod4(from[i] + outcome.turns.all + (outcome.turns.pages.get(i) ?? 0));
        state.applied.set(outcome.to, to);
        state.lastHash = outcome.hash;
    }
    state.pending = Math.max(0, state.pending - presses);
    if (!state.pending) {
        if (!state.lastHash || !state.frames.size) { clear(documentId); return; }
        state.expectedHash = state.lastHash;
        const expected = state.expectedHash;
        setTimeout(() => { if (states.get(documentId) === state && state.expectedHash === expected) clear(documentId); }, STAND_IN_LIMIT_MS);
    }
    state.version++;
    emit();
}

export function presentedPdfRotation(documentId: string, pane: Element, hash: string): void {
    const state = states.get(documentId);
    if (!state || state.pending || state.expectedHash !== hash) return;
    const frame = state.frames.get(pane);
    if (frame) { release(frame.canvas); state.frames.delete(pane); }
    if (!state.frames.size) clear(documentId);
    else { state.version++; emit(); }
}

export function clearPdfRotationStandIn(documentId: string): void { clear(documentId); }

function release(canvas: HTMLCanvasElement): void { canvas.width = canvas.height = 0; }
function dispose(state: DocumentState): void {
    for (const frame of state.frames.values()) release(frame.canvas);
    for (const picture of state.pictures.values()) { release(picture.image); if (picture.top) release(picture.top); }
    state.frames.clear(); state.pictures.clear();
}
function clear(documentId: string): void {
    const state = states.get(documentId);
    if (!state) return;
    dispose(state);
    states.delete(documentId);
    emit();
}
