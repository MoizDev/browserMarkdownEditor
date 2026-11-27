import { NoticeDispatcher } from '../change/notices';
import type { HistorySnapshot, HistoryStepInfo, TextSelectionSnapshot } from '../change/historyTypes';
import type { NodeId } from '../model/ids';
import type { createBoardRenderServices } from '../render/services';
import { SelectionState } from '../selection';
import { createBoardToolState } from '../input/boardTools';
import type { ToolState } from '../input/gesture';
import { TOOLS } from '../model/styles';
import { SampleStore } from '../ink/samples';
import { createJobAuthority, type JobAuthority } from '../security/admission';
import { SessionScene } from '../scene/sessionScene';
import type { SessionSceneOptions } from '../scene/sessionScene';
import type { RenderToken } from '../../platform/render/types';
import { admitPaintSourceRebind, type PaintSourceAdmission, type PaintSourceExpectation, type PaintSourceWitness } from './paintSourceRebind';
import { createBoardSession } from '../session/createBoardSession';
import type { BoardSession } from '../session/BoardSession';
import type { BoardSessionFactoryOptions, ComposedBoardSession } from '../session/factoryTypes';

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
        readonly scene: Omit<SessionSceneOptions, 'doc' | 'invalidate' | 'onError' | 'signal' | 'retainRenderer'>;
        readonly render: ReturnType<typeof createBoardRenderServices>;
        onHistoryLimit(): void;
    };
export interface BoardRuntime {
    readonly session: ComposedBoardSession;
    readonly selection: SelectionState;
    readonly tools: ToolState;
    readonly samples: SampleStore;
    readonly jobs: JobAuthority;
    readonly media: BoardSessionFactoryOptions['media'];
    readonly render: ReturnType<typeof createBoardRenderServices>;
    readonly encoder: BoardSessionFactoryOptions['encoder'];
    readonly ready: Promise<SessionScene>;
    readonly scene: SessionScene | null;
    readonly paintToken: RenderToken;
    readonly paintBinding: ReturnType<ReturnType<typeof createBoardRenderServices>['capturePaintBinding']>;
    rebindPaintSource(witness: PaintSourceWitness, expected: PaintSourceExpectation,
        adopt: (token: RenderToken) => void, isCurrent: () => boolean): PaintSourceAdmission;
    adoptPaintSource(witness: PaintSourceWitness, expected: PaintSourceExpectation, isCurrent: () => boolean): PaintSourceAdmission;
    bindView(sink: BoardRuntimeViewSink): () => void;
    viewVisibilityChanged(): void;
    registerOwned(dispose: () => void): () => void;
    flushFrame(frameId: number): void;
    dispose(): Promise<void>;
}
type Registration = { sink: BoardRuntimeViewSink; report: (error: unknown) => void };
const RELEASE_HIDDEN_MS = 2_000;
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
    if (!(options.samples instanceof SampleStore)) throw new TypeError('Board runtime requires its canonical writable sample store');
    const samples = options.samples;
    const first = options.doc.sheetOrder[0];
    if (!first) throw new Error('A board runtime needs a sheet');
    if (options.scene.token.documentId !== options.owner.documentId || options.scene.token.session !== options.owner.session) throw new Error('Scene token does not match board session');
    const jobs = createJobAuthority(`${options.owner.documentId}:${options.owner.session}`, options.scene.token.vaultEpoch, options.owner.session);
    const selection = new SelectionState(first.id), tools = createBoardToolState(options.doc.ui, options.doc.view.toolLock);
    const attached = new Set<Registration>(), controller = new AbortController();
    const owned = new Set<{ dispose(): void }>();
    let scene: SessionScene | null = null, disposed = false, pendingReveal: Set<NodeId> | undefined;
    let retiring: Promise<void> | undefined;
    let paintBinding = options.render.capturePaintBinding(options.scene.token);
    let paintToken: RenderToken = Object.freeze({ vaultEpoch: options.scene.token.vaultEpoch, documentId: options.scene.token.documentId,
        bytesGeneration: options.scene.token.bytesGeneration, session: options.scene.token.session }), adopting = false;
    const stopSelection = selection.subscribe(() => { pendingReveal = undefined; });
    const report = (error: unknown) => options.onFailure(error);
    const visible = (entry: Registration) => safe(entry, () => entry.sink.visible(), false);
    let shown = false, releasing: ReturnType<typeof setTimeout> | undefined;
    const viewsChanged = () => {
        let any = false;
        for (const entry of attached) if (visible(entry)) { any = true; break; }
        if (any && releasing !== undefined) { clearTimeout(releasing); releasing = undefined; }
        if (shown && !any && !disposed) {
            releasing = setTimeout(() => { releasing = undefined; if (!disposed) options.render.releaseDerived(); }, RELEASE_HIDDEN_MS);
        }
        shown = any;
    };
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
            if (applied.touched.board.has('ui.tool')) tools.adoptTool(options.doc.ui.tool);
            if (applied.touched.board.has('view.toolLock')) tools.setLocked(options.doc.view.toolLock);
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
    const stopTools = tools.subscribe(() => {
        if (disposed || session.isReadOnly) return;
        const captured = tools.getSnapshot();
        // Single-use completion happens at pointer-up, before asynchronous text
        // and shape preflight commits. Persisting UI earlier would invalidate it.
        void session.enqueueAfterGesture(controller.signal, () => {
            if (disposed || session.isReadOnly || tools.getSnapshot() !== captured) return;
            const ops: import('../change/ops').Op[] = [];
            const persistedTool = TOOLS.find(tool => tool === captured.active.id);
            if (persistedTool && options.doc.ui.tool !== persistedTool) ops.push({ t: 'board', key: 'ui.tool', value: persistedTool });
            if (options.doc.view.toolLock !== captured.locked) ops.push({ t: 'board', key: 'view.toolLock', value: captured.locked });
            if (ops.length) session.apply({ origin: 'host', label: 'Board tool preference', ops }).release();
        }).catch(error => { if (!disposed && !controller.signal.aborted) report(error); });
    });
    const ready = (async () => {
        for (;;) {
            controller.signal.throwIfAborted();
            const revision = options.doc.rev;
            try {
                const created = await SessionScene.create({ ...options.scene, retainRenderer: options.render.retainRenderer,
                    doc: options.doc, invalidate, onError: report, signal: controller.signal });
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
        session, selection, tools, samples, jobs, media: options.media, render: options.render, encoder: options.encoder, ready,
        get scene() { return scene; },
        get paintToken() { return paintToken; },
        get paintBinding() { return paintBinding; },
        rebindPaintSource(witness, expected, adopt, isCurrent) {
            if (disposed) throw new DOMException('Board runtime disposed', 'AbortError');
            if (adopting) throw new Error('A paint source rebind is already adopting');
            const admission = admitPaintSourceRebind(paintToken, expected, witness, () => !disposed && isCurrent());
            if (admission.unchanged) return admission;
            adopting = true;
            try { adopt(admission.token); } finally { adopting = false; }
            if (disposed) throw new DOMException('Board runtime disposed', 'AbortError');
            paintToken = admission.token;
            return admission;
        },
        adoptPaintSource(witness, expected, isCurrent) {
            if (disposed || !scene) throw new Error('Board paint source is not available');
            const target = scene;
            const admission = runtime.rebindPaintSource(witness, expected, token => {
                const binding = options.render.capturePaintBinding(token);
                target.setPaintBinding(binding);
                paintBinding = binding;
            }, isCurrent);
            if (!admission.unchanged) invalidate();
            return admission;
        },
        bindView(sink) {
            if (disposed) throw new Error('Board runtime disposed');
            const entry = { sink, report }; attached.add(entry); views.add(entry); notices.visibilityChanged(); flushReveal(); viewsChanged();
            let detached = false;
            return () => { if (detached) return; detached = true; attached.delete(entry); views.delete(entry); notices.visibilityChanged(); viewsChanged(); };
        },
        viewVisibilityChanged() { if (!disposed) { notices.visibilityChanged(); viewsChanged(); } },
        registerOwned(dispose) {
            if (disposed) throw new DOMException('Board runtime disposed', 'AbortError');
            if (typeof dispose !== 'function') throw new TypeError('Owned resource requires a disposer');
            const entry = { dispose }; owned.add(entry);
            return () => { owned.delete(entry); };
        },
        flushFrame(frameId) { if (!disposed) { notices.visibilityChanged(); flushReveal(); notices.flushFrame(frameId); } },
        dispose() {
            if (disposed) return retiring ?? Promise.resolve();
            disposed = true;
            if (releasing !== undefined) { clearTimeout(releasing); releasing = undefined; }
            for (const entry of owned) {
                owned.delete(entry);
                try { entry.dispose(); } catch (error) { try { report(error); } catch { /* Dispose every owner. */ } }
            }
            jobs.dispose(); controller.abort(); stopSelection(); stopTools();
            for (const entry of attached) views.delete(entry);
            attached.clear(); notices.visibilityChanged(); pendingReveal = undefined;
            runtimes.delete(session);
            retiring = (async () => {
                try { scene?.dispose(); } finally { scene = null; try { await session.dispose(); } finally { options.render.dispose(); } }
            })();
            return retiring;
        },
    };
    runtimes.set(session, runtime);
    return runtime;
}
