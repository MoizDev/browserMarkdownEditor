import { isSheetParent, sheetOf, type BoardDoc, type Sheet } from '../model/doc';
import type { NodeId, ParentId, SheetId } from '../model/ids';
import type { ExtBag, RawJson } from '../model/json';
import { isSafeMediaFile, type MediaId, type MediaLocations } from '../model/media';
import { createNode, type Node } from '../model/nodes';
import type { SampleLease, SampleRef, SampleStoreReader } from '../model/samples';
import { BOARD_FILE_FIELDS, NODE_FILE_FIELDS } from '../model/fileFields';
import {
    extensionForApply, ModelInvariantError, nodeMediaForApply, prepareMutationForApply,
    preparePreservedCountsForApply, prepareRevisionForApply, type ModelOp, type PreparedMutation,
} from '../model/applyOnly';
import { validateCommit, validateOp, type ValidationContext } from '../model/validate';
import { EMPTY_RICH_TEXT, spliceRichText, type RichText } from '../text/richText';
import {
    opDirties, policyForOp, SceneImpact, type Applied, type AppliedLease, type BoardKey, type BoardOp,
    type BoardValue, type ExtOp, type NodePropKey, type NodeSetOp, type Op, type PropValue,
    type TouchedSet, type Transaction, type TransactionOrigin, type TxBuilder,
} from './ops';
import { RawChanges, type PreservedDelta } from './rawChanges';
import { ApplyFailed, ApplyRefused } from './errors';
import { captureBeforeChange, normalizeChanges, type NormalizationStep } from './normalize';
import type { ChangeGeometry } from './coordinates';
export { ApplyFailed, ApplyRefused } from './errors';
const NO_CAPTURES = Object.freeze([]);

// CH §3/R-W27: callbacks borrow the receipt for this call only. History or a
// queued consumer calls retain() and releases that lease when it drops its work.
// Save/session code must refuse serialization while isReadOnly is true (D-10).
export interface ApplyConsumers {
    readonly history?: (applied: Applied, transaction: Transaction) => void;
    readonly scene?: (applied: Applied, impacts: ReadonlyMap<NodeId, number>) => void;
    readonly save?: (applied: Applied) => void;
    readonly change?: (applied: Applied) => void;
    readonly reportError?: (error: ApplyFailed) => void;
}
export interface ApplyController {
    readonly isReadOnly: boolean;
    readonly failure: ApplyFailed | null;
    apply(transaction: Transaction): Applied;
    begin(origin: TransactionOrigin, label: string): TxBuilder;
    /** Exact, validated rollback of latest committed receipts, newest first. */
    revert(receipts: readonly Applied[]): Applied;
    dispose(): void;
}

// Never reuse IDs: even a savepoint from another/expired builder is refused.
let nextSavepoint = 1;

function required<T>(value: T | undefined, reason: string): T {
    if (value === undefined) throw new ModelInvariantError(reason);
    return value;
}
function setValue(id: NodeId, key: NodePropKey, value: PropValue): NodeSetOp {
    // Both sides come from the same validated node property; TS cannot retain
    // that union correlation through a dynamic lookup.
    return { t: 'set', id, key, value } as NodeSetOp;
}
function boardValue(doc: BoardDoc, key: BoardKey): BoardValue {
    switch (key) {
        case 'host.paper':
            if (doc.host.kind !== 'notebook') throw new ModelInvariantError('Expected notebook paper');
            return doc.host.paper;
        case 'host.pdf':
            if (doc.host.kind !== 'pdf-ink') throw new ModelInvariantError('Expected PDF bookkeeping');
            return doc.host.pdf;
        case 'ui.tool': return doc.ui.tool;
        case 'ui.next': return doc.ui.next;
        case 'ui.penWidth': return doc.ui.penWidth;
        default: return doc.view[key.slice(5) as Exclude<keyof BoardDoc['view'], 'ext'>];
    }
}
function boardTarget(key: BoardKey): ExtOp['target'] {
    return key === 'host.paper' ? 'paper' : key === 'host.pdf' ? 'host' : key.startsWith('ui.') ? 'pen' : 'view';
}
function invalidate(ext: ExtBag | null, keys: readonly string[]): ExtBag | null | undefined {
    if (!ext?.raw.size) return undefined;
    let raw: Map<string, RawJson> | undefined;
    for (const key of keys) {
        if (!ext.raw.has(key)) continue;
        if (!raw) raw = new Map(ext.raw);
        raw.delete(key);
    }
    return raw ? raw.size || ext.fields.size ? { fields: ext.fields, raw } : null : undefined;
}
// Physical filenames are not history. Only actual undo/redo admission projects
// them; rollback calls planOp directly and restores captured file/raw data exactly.
function replayMediaLocation(op: Op, locations: MediaLocations | undefined): Op {
    if (!locations) return op;
    const id = op.t === 'media' && op.op === 'add' ? op.entry.id
        : op.t === 'ext' && op.target === 'media' ? op.id as MediaId : undefined;
    if (id === undefined) return op;
    const file = locations.currentFile(id);
    if (file === undefined) return op;
    if (!isSafeMediaFile(file)) throw new ApplyFailed('media-location', 'The media registry returned an unsafe filename');
    if (op.t === 'media' && op.op === 'add') {
        const ext = invalidate(op.entry.ext, ['file']);
        return { ...op, entry: { ...op.entry, file, ext: ext === undefined ? op.entry.ext : ext } };
    }
    if (op.t === 'ext') {
        const ext = invalidate(op.value, ['file']);
        return ext === undefined ? op : { ...op, value: ext };
    }
    return op;
}
function richValue(node: Node, key: 'text' | 'label'): RichText | null {
    return Reflect.get(node, key) as RichText | null;
}
interface LiveChange {
    readonly id: NodeId;
    readonly before: SampleLease | undefined;
    readonly after: SampleLease | undefined;
}
interface OpPlan {
    readonly forward: Op;
    readonly inverse: readonly Op[];
    readonly mutation: PreparedMutation;
    readonly counts: PreparedMutation | undefined;
    readonly delta: PreservedDelta;
    readonly refs: readonly SampleRef[];
    readonly live: { readonly id: NodeId; readonly next: SampleRef | undefined } | undefined;
    readonly touched: TouchedSet;
    readonly impacts: ReadonlyMap<NodeId, number>;
}
interface Entry extends NormalizationStep {
    readonly plan: OpPlan;
    readonly live: LiveChange | undefined;
    started: boolean;
}

// One physical lease per sample id in the receipt, regardless of how many ops
// mention it. Live-node handles are independent, so dropping undo never frees a
// sample still drawn by the document (and deleting a node does not free undo).
class ReceiptSamples {
    private readonly refs = new Map<SampleRef, { readonly lease: SampleLease; uses: number }>();
    constructor(private readonly samples: SampleStoreReader) {}
    add(ref: SampleRef): void {
        const existing = this.refs.get(ref);
        if (existing) { existing.uses++; return; }
        const lease = this.samples.retain(ref);
        try { this.refs.set(ref, { lease, uses: 1 }); }
        catch (error) { lease.release(); throw error; }
    }
    remove(ref: SampleRef): void {
        const entry = required(this.refs.get(ref), 'Receipt sample ownership vanished');
        if (--entry.uses !== 0) return;
        this.refs.delete(ref);
        entry.lease.release();
    }
    ids(): readonly SampleRef[] { return Object.freeze(Array.from(this.refs.keys())); }
    release(): void {
        for (const entry of this.refs.values()) entry.lease.release();
        this.refs.clear(); // Released receipts no longer pin chunks through handle closures.
    }
}
function receipt(forward: readonly Op[], inverse: readonly Op[], inverseGroups: readonly (readonly Op[])[], touched: TouchedSet,
    dirtying: boolean, recorded: boolean, samples: ReceiptSamples): Applied {
    const sampleRefs = samples.ids();
    let owners = 1, rootActive = true;
    const drop = () => { if (--owners === 0) samples.release(); };
    return Object.freeze({
        forward: Object.freeze(forward), inverse: Object.freeze(inverse), inverseGroups: Object.freeze(inverseGroups), touched, dirtying, recorded, sampleRefs,
        retain(): AppliedLease {
            if (owners === 0) throw new ApplyFailed('released', 'The applied receipt has been released');
            let active = true;
            const lease = Object.freeze({ release() { if (active) { active = false; drop(); } } });
            owners++; // Allocate/freeze BEFORE changing ownership, as for SampleStore.retain.
            return lease;
        },
        release() { if (rootActive) { rootActive = false; drop(); } },
    });
}
function emptyTouched(): { nodes: Set<NodeId>; sheets: Set<SheetId>; media: Set<MediaId>; board: Set<BoardKey> } {
    return { nodes: new Set(), sheets: new Set(), media: new Set(), board: new Set() };
}
function mergeTouched(into: ReturnType<typeof emptyTouched>, from: TouchedSet): void {
    for (const id of from.nodes) into.nodes.add(id);
    for (const id of from.sheets) into.sheets.add(id);
    for (const id of from.media) into.media.add(id);
    for (const key of from.board) into.board.add(key);
}
function touchParent(doc: BoardDoc, parent: ParentId, touched: ReturnType<typeof emptyTouched>, impacts: Map<NodeId, number>): void {
    for (let depth = 0; depth <= 64; depth++) {
        if (isSheetParent(doc, parent)) { touched.sheets.add(parent); return; }
        const node = doc.nodes.get(parent);
        if (!node) return;
        touched.nodes.add(node.id);
        impacts.set(node.id, (impacts.get(node.id) ?? 0) | SceneImpact.bounds | SceneImpact.children);
        parent = node.parent;
    }
    throw new ModelInvariantError('Touched parent chain exceeds 64 links');
}
function touches(doc: BoardDoc, op: Op, delta: PreservedDelta): { touched: TouchedSet; impacts: ReadonlyMap<NodeId, number> } {
    const touched = emptyTouched(), impacts = new Map<NodeId, number>();
    const policy = policyForOp(op);
    const touchNode = (node: Node) => {
        touched.nodes.add(node.id);
        impacts.set(node.id, (impacts.get(node.id) ?? 0) | policy.scene);
        const sheet = sheetOf(doc, node.parent);
        if (sheet !== undefined) touched.sheets.add(sheet);
        if (policy.scene & SceneImpact.ancestors) touchParent(doc, node.parent, touched, impacts);
        if (policy.scene & SceneImpact.attachments) {
            for (const id of doc.attachedTo.get(node.id) ?? []) {
                touched.nodes.add(id);
                impacts.set(id, (impacts.get(id) ?? 0) | SceneImpact.paint | SceneImpact.bounds);
            }
        }
    };
    if (op.t === 'create') touchNode(op.node as Node);
    else if (op.t === 'delete' || op.t === 'set' || op.t === 'splice' || (op.t === 'ext' && op.target === 'node')) {
        const node = required(doc.nodes.get(op.id as NodeId), 'Touched node vanished');
        touchNode(node);
        if (op.t === 'set' && op.key === 'parent') touchParent(doc, op.value, touched, impacts);
    } else if (op.t === 'sheet') touched.sheets.add(op.op === 'create' ? op.sheet.id : op.id);
    else if (op.t === 'media') touched.media.add(op.op === 'add' ? op.entry.id : op.id);
    else if (op.t === 'board') touched.board.add(op.key);
    else if (op.t === 'ext') {
        if (op.target === 'sheet') touched.sheets.add(op.id as SheetId);
        else if (op.target === 'media') touched.media.add(op.id as MediaId);
        else if (op.target === 'paper') touched.board.add('host.paper');
        else if (op.target === 'host') touched.board.add('host.pdf');
        else if (op.target === 'pen') { touched.board.add('ui.tool'); touched.board.add('ui.next'); touched.board.add('ui.penWidth'); }
        else { for (const key of ['view.grid', 'view.focusMode', 'view.toolLock', 'view.transparent', 'view.debugMode'] as const) touched.board.add(key); }
    }
    for (const id of delta.touched) touched.media.add(id);
    return { touched, impacts };
}

// Planning holds all old values before the first write, including raw metadata
// and its reference-count delta. Rollback uses these ordinary inverse ops through
// the SAME prepared mutators; there is no slot journal or hidden restoration data.
function planOp(doc: BoardDoc, input: Op): OpPlan | undefined {
    let forward = input, model: ModelOp;
    let extAfter: ExtBag | null | undefined;
    let extInverse: ExtOp | undefined;
    let inverse: Op[];
    const refs: SampleRef[] = [];
    let live: OpPlan['live'] = undefined;
    const ownMedia = input.t === 'media' ? input.op === 'add' ? input.entry.id : input.id
        : input.t === 'ext' && input.target === 'media' ? input.id as MediaId : undefined;
    const raw = new RawChanges(ownMedia);
    const sample = (node: Node) => { if (node.kind === 'stroke' && !refs.includes(node.samples)) refs.push(node.samples); };
    switch (input.t) {
        case 'create': {
            const node = createNode(input.node);
            forward = model = { t: 'create', node };
            inverse = [{ t: 'delete', id: node.id }];
            raw.node(node, 1);
            sample(node);
            if (node.kind === 'stroke') live = { id: node.id, next: node.samples };
            break;
        }
        case 'delete': {
            const node = required(doc.nodes.get(input.id), 'Inverse delete target vanished');
            inverse = [{ t: 'create', node: createNode(node) }];
            model = forward = { ...input };
            raw.node(node, -1);
            sample(node);
            if (node.kind === 'stroke') live = { id: node.id, next: undefined };
            break;
        }
        case 'set': case 'splice': {
            const node = required(doc.nodes.get(input.id), 'Inverse set target vanished');
            const before = Reflect.get(node, input.key) as PropValue;
            if (input.t === 'splice') {
                const text = richValue(node, input.key);
                const result = spliceRichText(text ?? EMPTY_RICH_TEXT, input.from, input.to, input.insert, input.wholeBlocks === true || input.replaceBlocks === true);
                model = setValue(node.id, input.key, result.text);
                forward = { ...input };
                inverse = text === null ? [setValue(node.id, input.key, null)]
                    : [{ t: 'splice', id: node.id, key: input.key, ...result.inverse }];
                raw.rich(result.before, result.after);
            } else {
                model = forward = { ...input };
                inverse = [setValue(node.id, input.key, before)];
                if (input.key === 'text' || input.key === 'label') raw.rich((before as RichText | null)?.blocks ?? [], input.value?.blocks ?? []);
                if (input.key === 'samples' && node.kind === 'stroke') {
                    sample(node);
                    if (!refs.includes(input.value)) refs.push(input.value);
                    if (node.samples !== input.value) live = { id: node.id, next: input.value };
                }
            }
            extAfter = invalidate(node.ext, NODE_FILE_FIELDS[input.key]);
            if (extAfter !== undefined) {
                extInverse = { t: 'ext', target: 'node', id: node.id, value: node.ext };
                raw.extension(node.ext, extAfter);
            }
            break;
        }
        case 'sheet':
            if (input.op === 'create') {
                const sheet: Sheet = { ...input.sheet };
                forward = model = { t: 'sheet', op: 'create', sheet };
                inverse = [{ t: 'sheet', op: 'delete', id: sheet.id }];
                raw.extension(null, sheet.ext);
            } else {
                const sheet = required(doc.sheets.get(input.id), 'Inverse sheet target vanished');
                forward = model = { ...input };
                if (input.op === 'delete') {
                    inverse = [{ t: 'sheet', op: 'create', sheet: { ...sheet } }];
                    raw.extension(sheet.ext, null);
                } else {
                    inverse = [{ ...input, value: sheet[input.key] }];
                    extAfter = invalidate(sheet.ext, [input.key]);
                    if (extAfter !== undefined) {
                        extInverse = { t: 'ext', target: 'sheet', id: sheet.id, value: sheet.ext };
                        raw.extension(sheet.ext, extAfter);
                    }
                }
            }
            break;
        case 'media':
            if (input.op === 'add') {
                forward = model = { ...input, entry: { ...input.entry } };
                inverse = [{ t: 'media', op: 'drop', id: input.entry.id,
                    ...((doc.preservedMediaRefs.get(input.entry.id) ?? 0) > 0 ? { restoreMissing: true as const } : {}) }];
                raw.extension(null, input.entry.ext);
            } else if (input.op === 'set-file') {
                const entry = required(doc.media.get(input.id), 'Inverse media file target vanished');
                forward = model = { ...input };
                extAfter = 'restoreExt' in input ? input.restoreExt : invalidate(entry.ext, ['file']);
                inverse = [{ t: 'media', op: 'set-file', id: input.id, file: entry.file, restoreExt: entry.ext }];
                if (extAfter !== undefined) raw.extension(entry.ext, extAfter);
            } else {
                const entry = required(doc.media.get(input.id), 'Inverse media target vanished');
                forward = model = { ...input };
                inverse = [{ t: 'media', op: 'add', entry: { ...entry } }];
                raw.extension(entry.ext, null);
            }
            break;
        case 'board': {
            const target = boardTarget(input.key), ext = extensionForApply(doc, target);
            forward = model = { ...input };
            inverse = [{ t: 'board', key: input.key, value: boardValue(doc, input.key) } as BoardOp];
            extAfter = invalidate(ext, BOARD_FILE_FIELDS[input.key]);
            if (extAfter !== undefined) {
                extInverse = { t: 'ext', target, value: ext };
                raw.extension(ext, extAfter);
            }
            if (input.key === 'host.pdf') raw.value(boardValue(doc, input.key) as RawJson, input.value);
            break;
        }
        case 'ext': {
            const before = extensionForApply(doc, input.target, input.id);
            forward = model = { ...input };
            inverse = [{ ...input, value: before }];
            raw.extension(before, input.value);
            break;
        }
    }
    const mutation = prepareMutationForApply(doc, model, extAfter);
    if (!mutation) return undefined;
    // Base inverse first: it may itself invalidate raw tokens. Restore ext LAST.
    if (extInverse) inverse.push(extInverse);
    const delta = raw.finish();
    const counts = preparePreservedCountsForApply(doc, delta.counts);
    const touched = touches(doc, forward, delta);
    const mediaBefore = input.t === 'delete' || input.t === 'set' ? doc.nodes.get(input.id) : undefined;
    const beforeRefs = mediaBefore ? nodeMediaForApply(mediaBefore) : [];
    const afterRefs = model.t === 'create' ? nodeMediaForApply(model.node as Node)
        : model.t === 'set' && mediaBefore && (model.key === 'media' || model.key === 'preview')
            ? nodeMediaForApply({ ...mediaBefore, [model.key]: model.value } as Node)
            : input.t === 'delete' ? [] : beforeRefs;
    const media = touched.touched.media as Set<MediaId>;
    for (const id of beforeRefs) if (!afterRefs.includes(id)) media.add(id);
    for (const id of afterRefs) if (!beforeRefs.includes(id)) media.add(id);
    return { forward, inverse, mutation, counts, delta, refs, live, ...touched };
}

export function createApplyController(doc: BoardDoc, samples: SampleStoreReader, consumers: ApplyConsumers = {}, geometry?: ChangeGeometry, mediaLocations?: MediaLocations): ApplyController {
    const live = new Map<NodeId, SampleLease>();
    try {
        for (const node of doc.nodes.values()) {
            if (node.kind !== 'stroke') continue;
            const lease = samples.retain(node.samples);
            try { live.set(node.id, lease); }
            catch (error) { lease.release(); throw error; }
        }
    } catch (error) {
        for (const lease of live.values()) lease.release();
        live.clear();
        throw error;
    }
    let phase: 'idle' | 'building' | 'publishing' | 'disposed' = 'idle';
    let active: TxBuilder | undefined;
    let readOnly = false, failure: ApplyFailed | null = null;
    let faultSamples: ReceiptSamples | undefined;
    let allowRevert = false, expectedRevision = doc.rev;
    let logicalHead: WeakRef<Applied> | undefined;
    const links = new WeakMap<Applied, WeakRef<Applied> | null>();
    const report = (error: ApplyFailed) => {
        if (!failure?.unsafe || error.unsafe) failure = error;
        try { consumers.reportError?.(error); } catch { /* Reporting cannot reopen or undo a commit. */ }
    };
    const publish = (applied: Applied, transaction: Transaction, impacts: ReadonlyMap<NodeId, number>) => {
        // Lookup is protected too: a broken consumer must not prevent the other
        // three from seeing an already committed version (R-W27).
        try { consumers.history?.(applied, transaction); }
        catch (error) { report(new ApplyFailed('consumer', 'History consumer failed after commit', false, error)); }
        try { consumers.scene?.(applied, impacts); }
        catch (error) { report(new ApplyFailed('consumer', 'Scene consumer failed after commit', false, error)); }
        try { consumers.save?.(applied); }
        catch (error) { report(new ApplyFailed('consumer', 'Save consumer failed after commit', false, error)); }
        try { consumers.change?.(applied); }
        catch (error) { report(new ApplyFailed('consumer', 'Change consumer failed after commit', false, error)); }
    };
    const guard = () => {
        if (phase === 'disposed') throw new ApplyFailed('disposed', 'The board session is closed');
        if (readOnly) throw new ApplyFailed('read-only', 'The board session is read-only after an internal failure', true);
        if (phase !== 'idle') throw new ApplyFailed('re-entrant', 'A board transaction is already running');
    };
    const controller: ApplyController = {
        get isReadOnly() { return readOnly; },
        get failure() { return failure; },
        apply(transaction) {
            const builder = controller.begin(transaction.origin, transaction.label);
            try {
                for (const op of transaction.ops) builder.push(op);
                return builder.commit();
            } catch (error) {
                builder.abort();
                if (error instanceof ApplyRefused || error instanceof ApplyFailed) throw error;
                throw new ApplyFailed('apply', 'The board transaction failed', false, error);
            }
        },
        begin(origin, label) {
            guard();
            if (origin === 'revert' && !allowRevert) throw new ApplyFailed('origin', 'Internal revert cannot be started externally');
            const context: ValidationContext = { doc, samples, origin };
            const entries: Entry[] = [], resources = new ReceiptSamples(samples);
            const savepoints = new Map<number, number>();
            let closed = false, committing = false, staging = false, attempted = 0;
            const assertStaging = () => {
                if (closed || phase !== 'building' || active !== builder) throw new ApplyFailed('closed-builder', 'The transaction builder is closed');
            };
            const assertOpen = () => {
                assertStaging();
                if (committing || staging) throw new ApplyFailed('re-entrant', 'The transaction is already applying changes');
            };
            const releaseEntry = (entry: Entry) => {
                if (entry.live) {
                    if (entry.live.before) live.set(entry.live.id, entry.live.before);
                    else live.delete(entry.live.id);
                    entry.live.after?.release();
                }
            };
            const rollback = (point: number, unsafe: boolean): void => {
                let rollbackError: unknown;
                for (let i = entries.length - 1; i >= point; i--) {
                    const entry = entries[i];
                    if (entry.started) {
                        for (const inverse of entry.plan.inverse) {
                            try {
                                const plan = planOp(doc, inverse);
                                plan?.mutation.write();
                                plan?.counts?.write();
                            } catch (error) { rollbackError ??= error; unsafe = true; }
                        }
                    }
                    try { releaseEntry(entry); }
                    catch (error) { rollbackError ??= error; unsafe = true; }
                    if (!unsafe) {
                        try { for (const ref of entry.plan.refs) resources.remove(ref); }
                        catch (error) { rollbackError ??= error; unsafe = true; }
                    }
                }
                entries.length = point;
                for (const [id, position] of savepoints) if (position > point) savepoints.delete(id);
                if (unsafe) {
                    readOnly = true;
                    // The model might still mention a staged ref after a defective
                    // mutator/rollback. Quarantine its lease until session disposal.
                    faultSamples = resources;
                    const error = new ApplyFailed('unsafe-mutation', 'Board changes could not be completed safely; reload to continue. Saving is disabled.', true, rollbackError);
                    report(error);
                    throw error;
                }
            };
            const close = () => { savepoints.clear(); closed = true; active = undefined; phase = 'idle'; };
            const fail = (cause: unknown, unsafe = false): never => {
                try {
                    rollback(0, unsafe);
                    if (cause instanceof ApplyRefused) throw cause;
                    const error = cause instanceof ApplyFailed ? cause : new ApplyFailed('apply', 'The board transaction failed', false, cause);
                    report(error); // Still guarded while reportError executes.
                    throw error;
                } finally { close(); }
            };
            const stageBody = (input: Op): void => {
                const opIndex = attempted++;
                const historyReplay = origin === 'undo' || origin === 'redo';
                const replay = historyReplay || origin === 'revert';
                // History never rewinds physical names; receipt rollback stays exact.
                if (historyReplay && input.t === 'media' && input.op === 'set-file') return;
                let op = input;
                const result = validateOp(context, op, opIndex);
                if (!result.ok) throw new ApplyRefused(result);
                let plan: OpPlan | undefined, captured: NormalizationStep['captured'];
                try {
                    if (historyReplay) op = replayMediaLocation(op, mediaLocations);
                    plan = planOp(doc, op);
                    captured = !plan || replay ? NO_CAPTURES : captureBeforeChange(doc, plan.forward, geometry);
                } catch (error) {
                    if (error instanceof ApplyRefused) throw new ApplyRefused({ ok: false, code: error.code, reason: error.reason, nodeId: error.nodeId, opIndex });
                    return fail(error, error instanceof ModelInvariantError);
                }
                if (!plan) return;
                let owned = 0, after: SampleLease | undefined, entry: Entry;
                try {
                    for (const ref of plan.refs) { resources.add(ref); owned++; }
                    const before = plan.live ? live.get(plan.live.id) : undefined;
                    if (plan.live?.next !== undefined) after = samples.retain(plan.live.next);
                    entry = { plan, op: plan.forward, touched: plan.touched, captured,
                        live: plan.live ? { id: plan.live.id, before, after } : undefined, started: false };
                    entries.push(entry);
                } catch (error) {
                    after?.release();
                    for (let i = owned - 1; i >= 0; i--) resources.remove(plan.refs[i]);
                    return fail(error);
                }
                try {
                    entry.started = true;
                    plan.mutation.write();
                    plan.counts?.write();
                    if (entry.live) {
                        if (entry.live.after) live.set(entry.live.id, entry.live.after);
                        else live.delete(entry.live.id);
                    }
                } catch (error) { return fail(error, true); }
            };
            const stage = (op: Op): void => {
                assertStaging();
                if (staging) throw new ApplyFailed('re-entrant', 'A board operation is already staging');
                staging = true;
                try { stageBody(op); }
                finally { staging = false; }
            };
            const builder: TxBuilder = {
                savepoint() {
                    assertOpen();
                    if (!Number.isSafeInteger(nextSavepoint)) throw new ApplyFailed('savepoint', 'Savepoint id space exhausted');
                    const id = nextSavepoint++;
                    savepoints.set(id, entries.length);
                    return id;
                },
                rollbackTo(id) {
                    assertOpen();
                    const point = savepoints.get(id);
                    if (point === undefined) throw new ApplyFailed('savepoint', 'Invalid or expired transaction savepoint');
                    try { rollback(point, false); }
                    catch (error) { return fail(error, true); }
                },
                push(op) { assertOpen(); stage(op); },
                commit() {
                    assertOpen();
                    committing = true;
                    let applied: Applied, impacts: Map<NodeId, number>, transaction: Transaction;
                    const beforeRevision = doc.rev;
                    let restoreRevision: PreparedMutation | undefined;
                    let revisionStarted = false;
                    try {
                        // Undo/redo already contain the exact follow-on ops. In
                        // particular imported long keys must be restored verbatim.
                        if (origin !== 'undo' && origin !== 'redo' && origin !== 'revert') normalizeChanges(doc, { push: stage }, entries, geometry);
                        const forward: Op[] = [], inverse: Op[] = [], inverseGroups: (readonly Op[])[] = [], touched = emptyTouched();
                        impacts = new Map();
                        let dirtying = false, recorded = false;
                        for (const entry of entries) {
                            forward.push(entry.plan.forward);
                            inverseGroups.push(Object.freeze(entry.plan.inverse.map(op => Object.freeze({ ...op }))));
                            mergeTouched(touched, entry.plan.touched);
                            for (const [id, mask] of entry.plan.impacts) impacts.set(id, (impacts.get(id) ?? 0) | mask);
                            const policy = policyForOp(entry.plan.forward);
                            dirtying ||= opDirties(policy, doc.kind);
                            recorded ||= policy.history;
                        }
                        for (let i = inverseGroups.length - 1; i >= 0; i--) {
                            for (const op of inverseGroups[i]) inverse.push(op);
                        }
                        applied = receipt(forward, inverse, inverseGroups, touched, dirtying, recorded && origin !== 'undo' && origin !== 'redo' && origin !== 'revert', resources);
                        transaction = { ops: applied.forward, origin, label };
                        // Prepare both revision writes before either is run. An
                        // empty/no-op transaction is not a new document version.
                        restoreRevision = prepareRevisionForApply(doc, beforeRevision);
                        const revision = prepareRevisionForApply(doc, beforeRevision + (entries.length ? 1 : 0));
                        revisionStarted = true;
                        revision.write();
                        const result = validateCommit(context, touched, forward, attempted);
                        if (!result.ok) throw new ApplyRefused(result);
                    } catch (error) {
                        // An unexpected staged-mutator failure already rolled back,
                        // reported and closed this builder through fail().
                        if (closed) throw error;
                        try { restoreRevision?.write(); }
                        catch (restoreError) { return fail(restoreError, true); }
                        return fail(error, error instanceof ModelInvariantError || (revisionStarted && !(error instanceof ApplyRefused)));
                    }
                    // R-W27 COMMIT POINT: successful end of commit check. No
                    // consumer exception can roll back this published version.
                    if (entries.length) {
                        if (origin !== 'revert') { links.set(applied, logicalHead ?? null); logicalHead = new WeakRef(applied); }
                        expectedRevision = doc.rev;
                    }
                    savepoints.clear();
                    closed = true;
                    active = undefined;
                    phase = 'publishing';
                    for (const entry of entries) {
                        try { entry.live?.before?.release(); }
                        catch (error) { readOnly = true; report(new ApplyFailed('sample-release', 'Sample ownership failed; saving is disabled', true, error)); }
                    }
                    entries.length = 0;
                    try { if (applied.forward.length) publish(applied, transaction, impacts); }
                    finally { phase = 'idle'; }
                    return applied;
                },
                abort() {
                    if (closed) return;
                    assertOpen();
                    try { rollback(0, false); }
                    finally { close(); }
                },
            };
            phase = 'building';
            active = builder;
            return builder;
        },
        revert(receipts) {
            guard();
            if (!receipts.length || doc.rev !== expectedRevision) throw new ApplyFailed('revert', 'History receipts are not the latest board commits');
            let cursor = logicalHead;
            const ops: Op[] = [];
            for (const item of receipts) {
                if (cursor?.deref() !== item || !links.has(item)) throw new ApplyFailed('revert', 'History receipts are not the latest board commits');
                for (let i = item.inverseGroups.length - 1; i >= 0; i--) for (const op of item.inverseGroups[i]) ops.push(op);
                cursor = links.get(item) ?? undefined;
            }
            allowRevert = true;
            try {
                const result = controller.apply({ origin: 'revert', label: 'Revert gesture', ops });
                logicalHead = cursor;
                return result;
            } finally { allowRevert = false; }
        },
        dispose() {
            if (phase === 'disposed') return;
            if (phase === 'publishing') throw new ApplyFailed('re-entrant', 'Cannot dispose a board during change publication');
            try { active?.abort(); }
            finally {
                phase = 'disposed';
                for (const lease of live.values()) lease.release();
                live.clear();
                faultSamples?.release();
                faultSamples = undefined;
            }
        },
    };
    return controller;
}
