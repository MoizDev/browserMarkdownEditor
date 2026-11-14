import type { ContentSource, SourceOwner } from '../../utils/documentBuffers';
import { createApplyController } from '../change/apply';
import { ApplyFailed } from '../change/errors';
import { History } from '../change/history';
import type { BoardKey, TouchedSet, Transaction, TransactionOrigin } from '../change/ops';
import { mediaExtension } from '../media/ingest';
import type { MediaLease } from '../media/store';
import type { NodeId, SheetId } from '../model/ids';
import { MEDIA_MIMES, type MediaId, type MediaMime } from '../model/media';
import { boardContentSource, type PinnedBoardBuild } from './contentSource';
import { createSessionGestureQueue } from './gestureQueue';
import { createSaveScheduler } from './saveScheduler';
import type { BoardSessionFactoryOptions, ComposedBoardSession } from './factoryTypes';
import type { SerializerCheckpoint } from '../format/serializerClient';

function emptyTouched(): { nodes: Set<NodeId>; sheets: Set<SheetId>; board: Set<BoardKey>; media: Set<MediaId> } {
    return { nodes: new Set(), sheets: new Set(), board: new Set(), media: new Set() };
}
function addTouched(target: ReturnType<typeof emptyTouched>, source: TouchedSet): void {
    for (const value of source.nodes) target.nodes.add(value);
    for (const value of source.sheets) target.sheets.add(value);
    for (const value of source.board) target.board.add(value);
    for (const value of source.media) target.media.add(value);
}

/** The App session store owns one factory result, independent of attached panes. */
export function createBoardSession(options: BoardSessionFactoryOptions): ComposedBoardSession {
    const { doc, samples, media, selection, serializer, records, encoder, journal } = options;
    const owner: SourceOwner = Object.freeze({ documentId: options.owner.documentId, session: options.owner.session });
    if (!owner.documentId || !Number.isSafeInteger(owner.session) || owner.session < 1) throw new RangeError('Invalid board session owner');
    let disposed = false, recovering = false;
    let contentRevision = doc.rev, savedRevision = doc.rev;
    let pending = emptyTouched(), pendingDirty = false;
    const mediaLeases = new Map<MediaId, MediaLease>();
    const listeners = new Set<(source: ContentSource) => void>();
    const pendingListeners = new Set<() => void>();
    let notifyingPending = false, lastPending = false;
    const pendingState = () => !disposed && (recovering || contentRevision > savedRevision || scheduler.hasPendingEdits() || outstanding.size > 0);
    const reportPendingError = (error: unknown) => { try { options.onFailure(error); } catch { /* a listener cannot break the save funnel */ } };
    const notifyPending = () => {
        if (notifyingPending) return;
        notifyingPending = true;
        try {
            while (pendingState() !== lastPending) {
                lastPending = pendingState();
                for (const listener of [...pendingListeners]) {
                    try { listener(); } catch (error) { reportPendingError(error); }
                }
            }
        } finally { notifyingPending = false; }
    };
    const checkpoints = new Map<number, { checkpoint: SerializerCheckpoint; context: unknown }>();
    const outstanding = new Set<Promise<unknown>>();
    // Revoked at dispose: every build that can still read a pinned source observes this signal.
    const lifetime = new AbortController();
    let cachedSource: { revision: number; handle: ReturnType<typeof boardContentSource>; context: unknown } | undefined;
    const retireSource = () => { const previous = cachedSource; cachedSource = undefined; previous?.handle.release(); };
    // Each step waits for the work that may still read the one it releases. A journal drain may start a
    // build, so the loop runs until nothing is outstanding. Nothing is claimed released before it is.
    const retireSettled = async () => {
        try {
            do {
                while (outstanding.size) await Promise.allSettled([...outstanding]);
                await journal.drain();
            } while (outstanding.size);
            retireSource(); journal.dispose(); serializer.dispose(); media.clear();
        } catch (error) { reportPendingError(error); }
    };
    const track = <T>(work: Promise<T>): Promise<T> => {
        outstanding.add(work); notifyPending();
        const settled = () => { outstanding.delete(work); notifyPending(); };
        void work.then(settled, settled);
        return work;
    };
    const readonlyReason = () => options.readOnlyReason() ?? (applyController.isReadOnly ? 'The board cannot be saved safely; reload to continue.' : null);
    const guardOwnership = () => {
        if (notifyingPending) throw new ApplyFailed('stale-session', 'Cannot mutate during pending-work notification');
        if (disposed || !options.isCurrent(owner)) throw new ApplyFailed('stale-session', 'The board session has ended');
        if (readonlyReason()) throw new ApplyFailed('read-only', readonlyReason()!);
    };
    const guard = () => {
        guardOwnership();
        if (recovering) throw new ApplyFailed('read-only', 'Recovery is in progress');
    };
    const refreshMedia = (id: MediaId) => {
        const entry = doc.media.get(id);
        if (entry && media.currentFile(id) === undefined) media.setFile(id, entry.file);
        const referenced = !!doc.mediaRefs.get(id)?.size || (doc.preservedMediaRefs.get(id) ?? 0) > 0;
        const lease = mediaLeases.get(id);
        if (referenced && !lease) mediaLeases.set(id, media.retain(id, 'document'));
        else if (!referenced && lease) { mediaLeases.delete(id); lease.release(); }
    };
    for (const id of doc.mediaRefs.keys()) refreshMedia(id);
    for (const id of doc.preservedMediaRefs.keys()) refreshMedia(id);
    for (const [id, entry] of doc.media) if (media.currentFile(id) === undefined) media.setFile(id, entry.file);

    const channel = options.notices.createChannel(() => doc.rev);
    let previousSheet = selection.getSnapshot().sheet;
    const unsubscribeSelection = selection.subscribe(() => {
        const next = selection.getSnapshot();
        if (next.sheet !== previousSheet) { previousSheet = next.sheet; channel.sheetChanged(); }
        channel.selectionChanged();
    });
    const queue = createSessionGestureQueue({ owner, isCurrent: options.isCurrent, isReadOnly: () => recovering || !!readonlyReason() });
    const applyController = createApplyController(doc, samples, {
        history: (applied, transaction) => {
            try { history.record(applied, transaction); }
            finally {
                if (transaction.origin !== 'revert') for (const op of applied.forward) {
                    if (op.t === 'media' && op.op === 'set-file') media.setFile(op.id, op.file);
                }
            }
        },
        scene: options.sceneChanged,
        save: applied => {
            if (!applied.dirtying) return;
            addTouched(pending, applied.touched);
            pendingDirty = true;
            contentRevision = doc.rev;
            retireSource();
            for (const id of applied.touched.media) refreshMedia(id);
            try { journal.record(applied, contentRevision); }
            catch (error) { options.onFailure(error); }
            finally { scheduler.markDirty(); notifyPending(); }
        },
        change: applied => channel.record(applied),
        reportError: options.onFailure,
    }, options.geometry, media);
    const history = new History({
        snapshot: options.historySnapshot,
        switchSheet: sheet => selection.setSheet(sheet),
        sheetExists: sheet => doc.sheets.has(sheet),
        nodeExists: id => doc.nodes.has(id),
        restoreSelection: options.restoreHistorySelection,
        revealTouched: options.revealTouched,
        apply: transaction => { guardOwnership(); return applyController.apply(transaction); },
        revert: receipts => { guardOwnership(); return applyController.revert(receipts); },
        retainMedia: id => media.retain(id, 'history'),
        retainSample: ref => samples.retain(ref),
        sampleBytes: ref => samples.byteSize(ref),
        historyLimitReached: options.historyLimitReached,
        reportFailure: options.onFailure,
        beforeReplay: options.beforeHistoryReplay,
    });
    function encodePending(): void {
        if (!pendingDirty) return;
        const captured = pending, revision = contentRevision;
        const encoded = records.encode(doc, captured, encoder, revision);
        if (!encoded.ok) throw new Error(encoded.error.reason);
        serializer.update(encoded.value.delta);
        encoded.value.commit();
        pending = emptyTouched(); pendingDirty = false;
    }
    function capture(): ReturnType<typeof boardContentSource>['source'] {
        // A closed session must never pin a new build: retireSettled has already passed over the checkpoint map.
        if (disposed) throw new DOMException('Board session ended', 'AbortError');
        encodePending();
        if (cachedSource?.revision === contentRevision) return cachedSource.handle.source;
        retireSource();
        const buildCapture = options.captureBuild?.(contentRevision);
        const base = serializer.checkpoint(records.integrity(), doc.preserved.end, buildCapture?.overrides);
        if (base.revision !== contentRevision) throw new Error('Serializer and board revision differ');
        const pinned = options.pinBuild(base, contentRevision, buildCapture?.context);
        if (pinned.revision !== contentRevision) { pinned.release?.(); throw new Error('Pinned board build revision differs'); }
        let built: Uint8Array | Blob | undefined;
        const wrapped: PinnedBoardBuild = { revision: pinned.revision, async build(signal) {
            if (built) return built;
            if (disposed) throw new DOMException('Board session ended', 'AbortError');
            const result = await track(pinned.build(AbortSignal.any([signal, lifetime.signal])));
            built = result;
            return result;
        }, release: () => pinned.release?.() };
        const revision = contentRevision;
        const entry = { checkpoint: base, context: buildCapture?.context };
        const handle = boardContentSource(owner, wrapped, () => {
            if (checkpoints.get(revision) === entry) checkpoints.delete(revision);
        });
        checkpoints.set(revision, entry);
        cachedSource = { revision, handle, context: buildCapture?.context };
        return handle.source;
    }
    function report(): void {
        const source = capture();
        for (const listener of [...listeners]) {
            try { listener(source); } catch (error) { options.onFailure(error); }
        }
    }
    const scheduler = createSaveScheduler({
        flush: report,
        finishGesture: options.finishGesture,
        finishComposition: options.finishComposition,
        captureJournal: () => { const source = capture(); return journal.capture(source, cachedSource!.context); },
        journalError: options.onFailure,
    });
    const mediaReferenceSnapshot = () => {
        const names = new Set<string>(), unresolved = new Set<MediaId>();
        const resolve = (id: MediaId) => {
            const entry = doc.media.get(id), registered = media.currentFile(id);
            const file = registered === undefined ? entry?.file : registered;
            if (typeof file === 'string') { names.add(file); return; }
            if (entry && /^sha256:[0-9a-f]{64}$/.test(id) && (MEDIA_MIMES as readonly string[]).includes(entry.mime)) {
                names.add(`${id.slice(7)}.${mediaExtension(entry.mime as MediaMime)}`);
            } else unresolved.add(id);
        };
        for (const [id, refs] of doc.mediaRefs) if (refs.size) resolve(id);
        for (const [id, count] of doc.preservedMediaRefs) if (count > 0 && !doc.mediaRefs.get(id)?.size) resolve(id);
        return { names: Object.freeze([...names]), unresolved: Object.freeze([...unresolved]) };
    };
    const session = {
        owner, doc, samples, history,
        mediaReferences() { return mediaReferenceSnapshot().names; },
        mediaReferenceIssues() { return mediaReferenceSnapshot().unresolved; },
        get isReadOnly() { return !!readonlyReason(); },
        get readOnlyReason() { return readonlyReason(); },
        get isGestureActive() { return queue.isGestureActive; },
        apply(transaction: Transaction) { guard(); return applyController.apply(transaction); },
        preflight(transaction: Transaction) { guard(); return applyController.preflight(transaction); },
        begin(origin: TransactionOrigin, label: string) { guard(); return applyController.begin(origin, label); },
        enqueueAfterGesture<T>(signal: AbortSignal, task: () => T) { return queue.enqueueAfterGesture(signal, task); },
        beginGesture() {
            guard();
            const release = queue.beginGesture();
            scheduler.setGesture(true); notifyPending();
            let active = true;
            return () => { if (active) { active = false; try { release(); } finally { scheduler.setGesture(queue.isGestureActive); notifyPending(); } } };
        },
        setComposition(active: boolean) {
            if (notifyingPending) throw new ApplyFailed('stale-session', 'Cannot mutate during pending-work notification');
            scheduler.setComposition(active); notifyPending();
        },
        subscribe: channel.subscribe.bind(channel),
        hasPendingEdits: pendingState,
        onPending(listener: () => void) { pendingListeners.add(listener); return () => { pendingListeners.delete(listener); }; },
        checkpoint() { guard(); try { scheduler.flushNow(); return capture(); } finally { notifyPending(); } },
        acknowledge(revision: number, outcome: 'written' | 'conflict' | 'failed') {
            if (notifyingPending) throw new ApplyFailed('stale-session', 'Cannot mutate during pending-work notification');
            // A first format conversion can write admitted revision zero without a model edit.
            // Its built checkpoint is still the durable baseline; pruning makes repeats inert.
            if (disposed || outcome !== 'written' || revision < savedRevision || revision > contentRevision) return;
            const captured = checkpoints.get(revision);
            if (!captured?.checkpoint.product()) return;
            savedRevision = revision;
            // The durable write still needs serializer/PDF acknowledgement if journalling fails.
            try { journal.acknowledge(revision, captured.checkpoint.baseline()); }
            catch (error) { reportPendingError(error); }
            scheduler.setJournalPending(savedRevision < contentRevision);
            const finishWritten = async () => {
                try { await captured.checkpoint.written(); }
                catch (error) { reportPendingError(error); }
                // PDF source rebinding follows the real durable write even if its serializer failed.
                await options.afterWritten?.(revision, captured.context);
            };
            void track(finishWritten()).catch(reportPendingError);
            for (const key of checkpoints.keys()) if (key <= revision) checkpoints.delete(key);
            notifyPending();
        },
        async drain() {
            // A journal append may start another session-owned build while draining.
            do {
                while (outstanding.size) await Promise.allSettled([...outstanding]);
                await scheduler.drain();
                await journal.drain();
            } while (outstanding.size);
        },
        onChange(listener: (source: ContentSource) => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
        journalDelta() { if (disposed) return undefined; capture(); return journal.delta(cachedSource!.context); },
        async recover(payload: unknown) {
            guard();
            if (pendingState() || doc.rev !== savedRevision) throw new ApplyFailed('recovery-conflict', 'Current board state changed; save the recovery as a copy or reload before applying it');
            const release = queue.beginGesture();
            recovering = true; notifyPending();
            let opened = false;
            try {
                history.open('Recover unsaved changes'); opened = true;
                await journal.recover(payload, transaction => applyController.apply(transaction));
                history.close(); opened = false;
            } catch (error) {
                if (opened) history.cancel();
                throw error;
            } finally { recovering = false; release(); notifyPending(); }
        },
        flushNow() { guard(); try { scheduler.flushNow(); } finally { notifyPending(); } },
        pageHide() { if (!disposed) scheduler.pageHide(); },
        hidden() { if (!disposed) scheduler.hidden(); },
        dispose() {
            if (disposed) return;
            // Revoke first: new builds refuse, running builds abort. Physical sources are released only after
            // every tracked build has actually settled, so no reader can outlive the bytes or media it holds.
            disposed = true; lifetime.abort(new DOMException('Board session ended', 'AbortError'));
            notifyPending(); pendingListeners.clear();
            unsubscribeSelection(); channel.dispose(); queue.dispose(); scheduler.dispose(); history.dispose(); applyController.dispose();
            for (const lease of mediaLeases.values()) lease.release();
            mediaLeases.clear(); checkpoints.clear(); listeners.clear();
            void retireSettled();
        },
    };
    return session as ComposedBoardSession;
}
