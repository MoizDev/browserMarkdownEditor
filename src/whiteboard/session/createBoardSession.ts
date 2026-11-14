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
    const checkpoints = new Map<number, SerializerCheckpoint>();
    const outstanding = new Set<Promise<unknown>>();
    let cachedSource: { revision: number; source: ReturnType<typeof boardContentSource> } | undefined;
    const track = <T>(work: Promise<T>): Promise<T> => {
        outstanding.add(work);
        void work.then(() => outstanding.delete(work), () => outstanding.delete(work));
        return work;
    };
    const readonlyReason = () => options.readOnlyReason() ?? (applyController.isReadOnly ? 'The board cannot be saved safely; reload to continue.' : null);
    const guardOwnership = () => {
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
            cachedSource = undefined;
            for (const id of applied.touched.media) refreshMedia(id);
            try { journal.record(applied, contentRevision); }
            catch (error) { options.onFailure(error); }
            finally { scheduler.markDirty(); }
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
    function capture(): ReturnType<typeof boardContentSource> {
        encodePending();
        if (cachedSource?.revision === contentRevision) return cachedSource.source;
        const base = serializer.checkpoint(records.integrity(), doc.preserved.end);
        if (base.revision !== contentRevision) throw new Error('Serializer and board revision differ');
        const pinned = options.pinBuild(base, contentRevision);
        if (pinned.revision !== contentRevision) throw new Error('Pinned board build revision differs');
        let built: Uint8Array | Blob | undefined;
        const wrapped: PinnedBoardBuild = { revision: pinned.revision, async build(signal) {
            if (built) return built;
            const result = await track(pinned.build(signal));
            built = result;
            return result;
        } };
        const source = boardContentSource(owner, wrapped);
        checkpoints.set(contentRevision, base);
        cachedSource = { revision: contentRevision, source };
        return source;
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
        captureJournal: () => journal.capture(),
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
        begin(origin: TransactionOrigin, label: string) { guard(); return applyController.begin(origin, label); },
        enqueueAfterGesture<T>(signal: AbortSignal, task: () => T) { return queue.enqueueAfterGesture(signal, task); },
        beginGesture() {
            guard();
            const release = queue.beginGesture();
            scheduler.setGesture(true);
            let active = true;
            return () => { if (active) { active = false; release(); scheduler.setGesture(queue.isGestureActive); } };
        },
        setComposition(active: boolean) { scheduler.setComposition(active); },
        subscribe: channel.subscribe.bind(channel),
        hasPendingEdits() { return !disposed && (contentRevision > savedRevision || scheduler.hasPendingEdits() || outstanding.size > 0); },
        checkpoint() { guard(); scheduler.flushNow(); return capture(); },
        acknowledge(revision: number, outcome: 'written' | 'conflict' | 'failed') {
            if (disposed || outcome !== 'written' || revision <= savedRevision || revision > contentRevision) return;
            const checkpoint = checkpoints.get(revision);
            if (!checkpoint?.product()) return;
            savedRevision = revision;
            journal.acknowledge(revision);
            scheduler.setJournalPending(savedRevision < contentRevision);
            void track(checkpoint.written()).catch(options.onFailure);
            for (const key of checkpoints.keys()) if (key <= revision) checkpoints.delete(key);
        },
        async drain() { while (outstanding.size) await Promise.allSettled([...outstanding]); await journal.drain(); },
        onChange(listener: (source: ContentSource) => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
        journalDelta() { return journal.delta(); },
        async recover(payload: unknown) {
            guard();
            const release = queue.beginGesture();
            recovering = true;
            history.open('Recover unsaved changes');
            try {
                await journal.recover(payload, transaction => applyController.apply(transaction));
                history.close();
            } catch (error) {
                history.cancel();
                throw error;
            } finally { recovering = false; release(); }
        },
        flushNow() { guard(); scheduler.flushNow(); },
        pageHide() { if (!disposed) scheduler.pageHide(); },
        hidden() { if (!disposed) scheduler.hidden(); },
        dispose() {
            if (disposed) return;
            disposed = true;
            unsubscribeSelection(); channel.dispose(); queue.dispose(); scheduler.dispose(); history.dispose(); applyController.dispose();
            for (const lease of mediaLeases.values()) lease.release();
            mediaLeases.clear(); journal.dispose(); serializer.dispose(); media.clear(); listeners.clear();
        },
    };
    return session as ComposedBoardSession;
}
