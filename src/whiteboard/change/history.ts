import type { MediaId } from '../model/media';
import type { NodeId } from '../model/ids';
import type { SampleRef } from '../model/samples';
import { scanRawMedia, visitExtRaw, visitNodeRaw, visitRichTextRaw } from '../model/rawMedia';
import type { RichText } from '../text/richText';
import { cancelTransientNodes, mentionsNode, operationOwner, OperationCoalescer, type HistoryOperation } from './historyCoalesce';
import type { HistoryController, HistoryLease, HistoryPorts, HistorySnapshot, HistoryStepInfo } from './historyTypes';
import { policyForOp, type Applied, type AppliedLease, type Op, type Transaction } from './ops';

const DEFAULT_LIMIT = 256 * 1024 * 1024;
interface Step {
    readonly label: string;
    readonly before: HistorySnapshot;
    after: HistorySnapshot;
    entries: HistoryOperation[];
    readonly samples: Map<SampleRef, HistoryLease>;
    readonly media: Map<MediaId, HistoryLease>;
    readonly touched: Set<NodeId>;
    bytes: number;
    readonly order: number;
    marks: Map<number, { readonly entries: number; readonly receipts: number }>;
    readonly receipts: { readonly applied: Applied; readonly lease: AppliedLease }[];
    baseEntries: number;
    reopened: boolean;
    coalescer: OperationCoalescer;
}
function snapshot(value: HistorySnapshot): HistorySnapshot {
    return { sheet: value.sheet, focus: value.focus, selected: [...value.selected], active: value.active, ...(value.text ? { text: { ...value.text } } : {}) };
}
function references(ops: readonly Op[], samples: Set<SampleRef>, media: Set<MediaId>): void {
    const raw = (value: Parameters<typeof scanRawMedia>[0]) => scanRawMedia(value, id => media.add(id));
    for (const op of ops) {
        if (op.t === 'create') {
            const node = op.node;
            if (node.kind === 'stroke') samples.add(node.samples);
            if ((node.kind === 'picture' || node.kind === 'clip') && node.media) media.add(node.media);
            visitNodeRaw(node, raw);
        } else if (op.t === 'set') {
            if (op.key === 'samples' && typeof op.value === 'number') samples.add(op.value);
            if (op.key === 'media' && typeof op.value === 'string') media.add(op.value as MediaId);
            if (op.key === 'text' || op.key === 'label') visitRichTextRaw(op.value as RichText | null, raw);
        } else if (op.t === 'splice') visitRichTextRaw(op.insert, raw);
        else if (op.t === 'ext') visitExtRaw(op.value, raw);
        else if (op.t === 'sheet' && op.op === 'create') visitExtRaw(op.sheet.ext, raw);
        else if (op.t === 'media') {
            media.add(op.op === 'add' ? op.entry.id : op.id);
            if (op.op === 'add') visitExtRaw(op.entry.ext, raw);
        }
    }
}
function estimate(value: unknown, seen: Set<object>): number {
    if (typeof value === 'string') return value.length * 2;
    if (typeof value === 'number' || typeof value === 'boolean') return 8;
    if (!value || typeof value !== 'object' || seen.has(value)) return 0;
    seen.add(value);
    if (ArrayBuffer.isView(value)) return value.byteLength;
    if (value instanceof ArrayBuffer) return value.byteLength;
    let bytes = 32;
    if (value instanceof Map) for (const [key, item] of value) bytes += estimate(key, seen) + estimate(item, seen);
    else if (Array.isArray(value)) for (const item of value) bytes += estimate(item, seen);
    else for (const [key, item] of Object.entries(value)) bytes += key.length * 2 + estimate(item, seen);
    return bytes;
}
function info(step: Step): HistoryStepInfo {
    return { label: step.label, sheet: step.before.sheet, touched: step.touched, before: step.before, after: step.after, bytes: step.bytes };
}
function inverse(entries: readonly HistoryOperation[]): Op[] {
    const result: Op[] = [];
    for (let i = entries.length - 1; i >= 0; i--) for (const op of entries[i].inverse) result.push(op);
    return result;
}

/** One controller belongs to one BoardSession and is never persisted. */
export class History implements HistoryController {
    private readonly undoStack: Step[] = [];
    private readonly redoStack: Step[] = [];
    private openStep: Step | undefined;
    private nextOrder = 1;
    private nextMark = 1;
    private totalBytes = 0;
    private warned = false;
    private disposed = false;
    constructor(private readonly ports: HistoryPorts, private readonly byteLimit = DEFAULT_LIMIT) {}
    get canUndo(): boolean { return this.undoStack.length > 0 || !!this.openStep?.entries.length; }
    get canRedo(): boolean { return this.redoStack.length > 0; }
    private makeStep(label: string): Step {
        const before = snapshot(this.ports.snapshot());
        const entries: HistoryOperation[] = [];
        return { label, before, after: before, entries, samples: new Map(), media: new Map(), touched: new Set(),
            bytes: 0, order: this.nextOrder++, marks: new Map(), receipts: [], baseEntries: 0, reopened: false, coalescer: new OperationCoalescer(entries, 0) };
    }
    open(label: string): void {
        if (this.disposed) throw new Error('History is disposed');
        if (this.openStep) throw new Error('A history step is already open');
        this.openStep = this.makeStep(label);
    }
    private retain(step: Step, operations: readonly HistoryOperation[]): void {
        const samples = new Set<SampleRef>(), media = new Set<MediaId>();
        for (const entry of operations) references([entry.forward, ...entry.inverse], samples, media);
        const acquiredSamples: [SampleRef, HistoryLease][] = [], acquiredMedia: [MediaId, HistoryLease][] = [];
        try {
            for (const ref of samples) if (!step.samples.has(ref)) acquiredSamples.push([ref, this.ports.retainSample(ref)]);
            for (const id of media) if (!step.media.has(id)) acquiredMedia.push([id, this.ports.retainMedia(id)]);
        } catch (error) {
            for (const [, lease] of acquiredSamples) lease.release();
            for (const [, lease] of acquiredMedia) lease.release();
            throw error;
        }
        for (const [ref, lease] of acquiredSamples) step.samples.set(ref, lease);
        for (const [id, lease] of acquiredMedia) step.media.set(id, lease);
    }
    private reconcile(step: Step): void {
        const samples = new Set<SampleRef>(), media = new Set<MediaId>();
        for (const entry of step.entries) references([entry.forward, ...entry.inverse], samples, media);
        for (const [ref, lease] of step.samples) if (!samples.has(ref)) { lease.release(); step.samples.delete(ref); }
        for (const [id, lease] of step.media) if (!media.has(id)) { lease.release(); step.media.delete(id); }
        const seen = new Set<object>();
        step.bytes = step.entries.length * 48 + step.touched.size * 16 + estimate(step.entries, seen)
            + estimate(step.before, seen) + estimate(step.after, seen);
        for (const ref of step.samples.keys()) step.bytes += this.ports.sampleBytes(ref);
    }
    record(applied: Applied, transaction: Transaction): void {
        if (this.disposed || !applied.recorded) return;
        const operations: HistoryOperation[] = [];
        for (let i = 0; i < applied.forward.length; i++) {
            const forward = applied.forward[i];
            if (policyForOp(forward).history) operations.push({ forward, inverse: applied.inverseGroups[i] });
        }
        if (!operations.length) return;
        const implicit = !this.openStep;
        const step = this.openStep ?? this.makeStep(transaction.label);
        const lease = applied.retain();
        try { this.retain(step, operations); }
        catch (error) { lease.release(); throw error; }
        step.receipts.push({ applied, lease });
        for (const operation of operations) step.coalescer.add(operation);
        for (const id of applied.touched.nodes) step.touched.add(id);
        if (implicit) { this.openStep = step; this.close(); }
    }
    close(): number | null {
        const step = this.openStep;
        if (!step) return null;
        this.openStep = undefined;
        step.after = snapshot(this.ports.snapshot());
        step.entries = cancelTransientNodes(step.entries);
        step.marks.clear();
        for (const receipt of step.receipts) receipt.lease.release();
        step.receipts.length = 0;
        step.reopened = false;
        this.reconcile(step);
        if (!step.entries.length) { this.release(step); return null; }
        this.clearRedo();
        this.undoStack.push(step);
        this.totalBytes += step.bytes;
        this.enforceLimit();
        return this.undoStack[this.undoStack.length - 1] === step ? step.order : null;
    }
    private release(step: Step): void {
        for (const receipt of step.receipts) receipt.lease.release();
        step.receipts.length = 0;
        for (const lease of step.samples.values()) lease.release();
        for (const lease of step.media.values()) lease.release();
        step.samples.clear(); step.media.clear(); step.entries = []; step.marks.clear();
    }
    clearRedo(): void {
        for (const step of this.redoStack) { this.totalBytes -= step.bytes; this.release(step); }
        this.redoStack.length = 0;
    }
    private enforceLimit(): void {
        let removed = false;
        while (this.totalBytes > this.byteLimit && (this.undoStack.length || this.redoStack.length)) {
            const oldestUndo = this.undoStack[0], oldestRedo = this.redoStack[this.redoStack.length - 1];
            if (oldestUndo && (!oldestRedo || oldestUndo.order < oldestRedo.order)) {
                this.undoStack.shift(); this.totalBytes -= oldestUndo.bytes; this.release(oldestUndo);
            } else {
                // Later redo steps depend on the older one, so discard that chain together.
                for (const step of this.redoStack) { this.totalBytes -= step.bytes; this.release(step); }
                this.redoStack.length = 0;
            }
            removed = true;
        }
        if (removed && !this.warned) { this.warned = true; this.ports.historyLimitReached(); }
    }
    mark(): number {
        const step = this.openStep;
        if (!step) throw new Error('A history mark requires an open step');
        const mark = this.nextMark++;
        step.marks.set(mark, { entries: step.entries.length, receipts: step.receipts.length });
        step.coalescer = new OperationCoalescer(step.entries, step.entries.length);
        return mark;
    }
    rollbackTo(mark: number): void {
        const step = this.openStep, point = step?.marks.get(mark);
        if (!step || point === undefined) throw new Error('Expired history mark');
        const tail = step.receipts.slice(point.receipts);
        if (tail.length && !this.revert(tail.map(item => item.applied).reverse())) return;
        for (const item of tail) item.lease.release();
        step.receipts.splice(point.receipts);
        step.entries.splice(point.entries);
        for (const [id, position] of step.marks) if (position.receipts >= point.receipts) step.marks.delete(id);
        step.coalescer = new OperationCoalescer(step.entries, point.entries);
        this.reconcile(step);
    }
    cancel(): void {
        const step = this.openStep;
        if (!step) return;
        if (step.receipts.length && !this.revert(step.receipts.map(item => item.applied).reverse())) return;
        this.openStep = undefined;
        if (step.reopened) {
            for (const item of step.receipts) item.lease.release();
            step.receipts.length = 0;
            step.entries.splice(step.baseEntries);
            step.marks.clear();
            this.reconcile(step);
            this.undoStack.push(step);
            this.totalBytes += step.bytes;
            this.ports.restoreSelection(this.filtered(step.after));
        } else {
            try { this.ports.restoreSelection(this.filtered(step.before)); }
            finally { this.release(step); }
        }
    }
    reopenLast(expected: number): boolean {
        if (this.openStep) throw new Error('A history step is already open');
        if (this.redoStack.length) return false;
        const step = this.undoStack[this.undoStack.length - 1];
        if (!step || step.order !== expected) return false;
        this.undoStack.pop();
        this.totalBytes -= step.bytes;
        step.marks.clear();
        step.baseEntries = step.entries.length;
        step.reopened = true;
        step.coalescer = new OperationCoalescer(step.entries, step.entries.length);
        this.openStep = step;
        return true;
    }
    forgetCreatedNode(node: NodeId, creationToken: number, ownedStepTokens: readonly number[]): boolean {
        if (this.openStep || this.redoStack.length) return false;
        const first = this.undoStack.findIndex(step => step.order === creationToken);
        if (first < 0 || !this.undoStack[first].entries.some(entry => entry.forward.t === 'create' && entry.forward.node.id === node)) return false;
        const allowed = new Set([creationToken, ...ownedStepTokens]);
        let deleted = false;
        for (let i = first; i < this.undoStack.length; i++) {
            const step = this.undoStack[i];
            for (const entry of step.entries) {
                const owner = operationOwner(entry.forward);
                if (owner === node) {
                    if (!allowed.has(step.order)) return false;
                    if (entry.forward.t === 'delete') deleted = true;
                } else if (mentionsNode(entry, node)) return false;
            }
        }
        if (!deleted) return false;
        for (let i = this.undoStack.length - 1; i >= first; i--) {
            const step = this.undoStack[i];
            if (!allowed.has(step.order)) continue;
            step.entries = step.entries.filter(entry => operationOwner(entry.forward) !== node);
            this.totalBytes -= step.bytes;
            this.reconcile(step);
            this.totalBytes += step.bytes;
            if (!step.entries.length) { this.undoStack.splice(i, 1); this.totalBytes -= step.bytes; this.release(step); }
        }
        return true;
    }
    private filtered(value: HistorySnapshot): HistorySnapshot {
        const selected = value.selected.filter(id => this.ports.nodeExists(id));
        const focus = value.focus === value.sheet || this.ports.nodeExists(value.focus as NodeId) ? value.focus : value.sheet;
        const active = value.active !== null && selected.includes(value.active) ? value.active : selected[selected.length - 1] ?? null;
        return { sheet: value.sheet, focus, selected, active, ...(value.text && this.ports.nodeExists(value.text.node) ? { text: value.text } : {}) };
    }
    private revert(receipts: readonly Applied[]): boolean {
        try { const applied = this.ports.revert(receipts); applied.release(); return true; }
        catch (error) { this.ports.reportFailure(error); return false; }
    }
    private replayOps(ops: readonly Op[], origin: 'undo' | 'redo', label: string): boolean {
        try {
            const applied = this.ports.apply({ ops, origin, label });
            applied.release();
            return true;
        } catch (error) {
            this.clear();
            this.ports.reportFailure(error);
            return false;
        }
    }
    private replay(direction: 'undo' | 'redo'): void {
        const candidate = direction === 'undo' ? (this.openStep?.entries.length ? this.openStep : this.undoStack[this.undoStack.length - 1]) : this.redoStack[this.redoStack.length - 1];
        if (candidate && candidate === this.openStep) candidate.after = snapshot(this.ports.snapshot());
        if (!candidate || this.ports.beforeReplay?.(info(candidate), direction) === false) return;
        this.close();
        const source = direction === 'undo' ? this.undoStack : this.redoStack;
        const target = direction === 'undo' ? this.redoStack : this.undoStack;
        const step = source[source.length - 1];
        if (!step) return;
        const state = direction === 'undo' ? step.before : step.after;
        const sheetExisted = this.ports.sheetExists(state.sheet);
        if (sheetExisted) this.ports.switchSheet(state.sheet);
        const ops = direction === 'undo' ? inverse(step.entries) : step.entries.map(entry => entry.forward);
        if (!this.replayOps(ops, direction, step.label)) return;
        source.pop(); target.push(step);
        if (!sheetExisted && this.ports.sheetExists(state.sheet)) this.ports.switchSheet(state.sheet);
        this.ports.restoreSelection(this.filtered(state));
        this.ports.revealTouched(step.touched);
    }
    undo(): void { this.replay('undo'); }
    redo(): void { this.replay('redo'); }
    clear(): void {
        if (this.openStep) { this.release(this.openStep); this.openStep = undefined; }
        for (const step of this.undoStack) this.release(step);
        this.undoStack.length = 0;
        this.clearRedo();
        this.totalBytes = 0;
    }
    dispose(): void { this.clear(); this.disposed = true; }
}
