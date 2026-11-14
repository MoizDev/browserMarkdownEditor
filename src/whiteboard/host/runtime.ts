import { NoticeDispatcher } from '../change/notices';
import type { HistorySnapshot, HistoryStepInfo, TextSelectionSnapshot } from '../change/historyTypes';
import type { NodeId } from '../model/ids';
import { SelectionState } from '../selection';
import { SessionScene } from '../scene/sessionScene';
import type { SessionSceneOptions } from '../scene/sessionScene';
import { createBoardSession } from '../session/createBoardSession';
import type { BoardSession } from '../session/BoardSession';
import type { BoardSessionFactoryOptions, ComposedBoardSession } from '../session/factoryTypes';

// Provenance: C7 session, scene, selection and application notice contracts;
// independent ownership wiring without third-party source.
export interface BoardRuntimeViewSink {
    visible(): boolean;
    focused(): boolean;
    invalidate(): void;
    finishGesture(): void;
    finishComposition(): void;
    reveal(ids: ReadonlySet<NodeId>): void;
    captureText?(): TextSelectionSnapshot | undefined;
    restoreText?(snapshot: TextSelectionSnapshot): void;
    beforeHistoryReplay?(step: HistoryStepInfo, direction: 'undo' | 'redo'): boolean;
}
export type BoardRuntimeOptions = Omit<BoardSessionFactoryOptions, 'selection' | 'notices' | 'sceneChanged'
    | 'historySnapshot' | 'restoreHistorySelection' | 'revealTouched' | 'finishGesture' | 'finishComposition'
    | 'beforeHistoryReplay' | 'historyLimitReached'> & {
        readonly scene: Omit<SessionSceneOptions, 'doc' | 'invalidate' | 'onError' | 'signal'>;
        onHistoryLimit(): void;
    };
export interface BoardRuntime {
    readonly session: ComposedBoardSession;
    readonly selection: SelectionState;
    readonly ready: Promise<SessionScene>;
    readonly scene: SessionScene | null;
    bindView(sink: BoardRuntimeViewSink): () => void;
    flushFrame(frameId: number): void;
    dispose(): void;
}
type Registration = { sink: BoardRuntimeViewSink; report: (error: unknown) => void };
const views = new Set<Registration>();
const runtimes = new WeakMap<BoardSession, BoardRuntime>();
function safe<T>(view: Registration, action: () => T, fallback: T): T {
    try { return action(); } catch (error) { try { view.report(error); } catch { /* A reporter cannot stop other panes. */ } return fallback; }
}
const notices = new NoticeDispatcher({
    hasVisiblePane: () => { for (const view of views) if (safe(view, () => view.sink.visible(), false)) return true; return false; },
    invalidateFrame: () => { for (const view of views) if (safe(view, () => view.sink.visible(), false)) safe(view, () => view.sink.invalidate(), undefined); },
    reportError: error => { const view = views.values().next().value as Registration | undefined; if (view) safe(view, () => view.report(error), undefined); },
});
export function getBoardRuntime(session: BoardSession): BoardRuntime | undefined { return runtimes.get(session); }

export function createBoardRuntime(options: BoardRuntimeOptions): BoardRuntime {
    const first = options.doc.sheetOrder[0];
    if (!first) throw new Error('A board runtime needs a sheet');
    if (options.scene.token.documentId !== options.owner.documentId || options.scene.token.session !== options.owner.session) throw new Error('Scene token does not match board session');
    const selection = new SelectionState(first.id), attached = new Set<Registration>(), controller = new AbortController();
    let scene: SessionScene | null = null, disposed = false, pendingReveal: Set<NodeId> | undefined;
    const stopSelection = selection.subscribe(() => { pendingReveal = undefined; });
    const report = (error: unknown) => options.onFailure(error);
    const visible = (entry: Registration) => safe(entry, () => entry.sink.visible(), false);
    const focused = (entry: Registration) => safe(entry, () => entry.sink.focused(), false);
    const preferred = (): Registration | undefined => {
        let firstVisible: Registration | undefined;
        for (const entry of attached) if (visible(entry)) { firstVisible ??= entry; if (focused(entry)) return entry; }
        return firstVisible;
    };
    const invalidate = () => {
        for (const entry of attached) if (visible(entry)) safe(entry, () => entry.sink.invalidate(), undefined);
    };
    const reveal = (ids: ReadonlySet<NodeId>) => {
        const target = preferred();
        if (!target) { pendingReveal ??= new Set(); for (const id of ids) pendingReveal.add(id); return; }
        const combined = new Set(pendingReveal); for (const id of ids) combined.add(id);
        pendingReveal = undefined;
        safe(target, () => target.sink.reveal(combined), undefined);
    };
    const flushReveal = () => { if (pendingReveal && preferred()) reveal(new Set()); };
    const historySnapshot = (): HistorySnapshot => {
        const snapshot = selection.getSnapshot();
        let text: TextSelectionSnapshot | undefined;
        for (const entry of attached) if (visible(entry) && focused(entry)) { text = safe(entry, () => entry.sink.captureText?.(), undefined); break; }
        return { ...snapshot, ...(text ? { text: { ...text } } : {}) };
    };
    const restoreHistorySelection = (snapshot: HistorySnapshot) => {
        selection.restore(options.doc, snapshot.sheet, snapshot.selected, snapshot.focus, snapshot.active);
        if (!snapshot.text) return;
        const text = snapshot.text;
        const ordered = [...attached];
        const focus = preferred();
        if (focus) { const index = ordered.indexOf(focus); if (index >= 0) { ordered.splice(index, 1); ordered.unshift(focus); } }
        const target = ordered.find(entry => safe(entry, () => entry.sink.captureText?.(), undefined)?.node === text.node && entry.sink.restoreText)
            ?? ordered.find(entry => visible(entry) && entry.sink.restoreText);
        if (target) safe(target, () => target.sink.restoreText!(text), undefined);
    };
    const session = createBoardSession({ ...options, selection, notices,
        sceneChanged(applied) {
            if (!options.doc.sheets.has(selection.getSnapshot().sheet)) {
                const sheet = options.doc.sheetOrder[0]; if (sheet) selection.setSheet(sheet.id);
            }
            selection.reconcile(options.doc);
            scene?.record(applied);
        },
        historySnapshot, restoreHistorySelection, revealTouched: reveal,
        finishGesture: () => { for (const entry of attached) safe(entry, () => entry.sink.finishGesture(), undefined); },
        finishComposition: () => { for (const entry of attached) safe(entry, () => entry.sink.finishComposition(), undefined); },
        beforeHistoryReplay(step, direction) {
            let allowed = true;
            for (const entry of attached) if (!safe(entry, () => entry.sink.beforeHistoryReplay?.(step, direction) ?? true, false)) allowed = false;
            return allowed;
        },
        historyLimitReached: options.onHistoryLimit,
    });
    const ready = (async () => {
        for (;;) {
            controller.signal.throwIfAborted();
            const revision = options.doc.rev;
            try {
                const created = await SessionScene.create({ ...options.scene, doc: options.doc, invalidate, onError: report, signal: controller.signal });
                if (disposed) { created.dispose(); throw new DOMException('Board runtime disposed', 'AbortError'); }
                if (options.doc.rev !== revision) { created.dispose(); continue; }
                scene = created; invalidate(); return created;
            } catch (error) {
                if (disposed || controller.signal.aborted) throw error;
                if (options.doc.rev !== revision) continue;
                report(error); throw error;
            }
        }
    })();
    void ready.catch(() => {});
    const runtime: BoardRuntime = {
        session, selection, ready,
        get scene() { return scene; },
        bindView(sink) {
            if (disposed) throw new Error('Board runtime disposed');
            const entry = { sink, report }; attached.add(entry); views.add(entry); notices.visibilityChanged(); flushReveal();
            let detached = false;
            return () => { if (detached) return; detached = true; attached.delete(entry); views.delete(entry); notices.visibilityChanged(); };
        },
        flushFrame(frameId) { if (!disposed) { notices.visibilityChanged(); flushReveal(); notices.flushFrame(frameId); } },
        dispose() {
            if (disposed) return;
            disposed = true; controller.abort(); stopSelection();
            for (const entry of attached) views.delete(entry);
            attached.clear(); notices.visibilityChanged(); pendingReveal = undefined;
            runtimes.delete(session);
            try { scene?.dispose(); } finally { scene = null; session.dispose(); }
        },
    };
    runtimes.set(session, runtime);
    return runtime;
}
