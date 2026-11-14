import type { Applied, BoardKey, Op, Transaction } from '../change/ops';
import { materializeBoardRecoveryRecipe } from '../format/recoveryRecipe';
import { SampleStore } from '../ink/samples';
import { acquireNativeBoard } from './nativeAcquisition';
import type { BoardDoc } from '../model/doc';
import type { NodeId, ParentId, SheetId } from '../model/ids';
import type { MediaEntry, MediaId } from '../model/media';
import type { Node } from '../model/nodes';
import { rehydrateLoad } from '../model/loadProjection';

// Provenance: C-20 recovery recipe, C5 re-admission and transactional model
// contracts; independent planner, no third-party source.
export async function recoverBoardJournal(payload: unknown, options: {
    doc: BoardDoc; samples: SampleStore; apply: (tx: Transaction) => Applied; signal: AbortSignal;
    cooperate?: () => Promise<void>; projectMedia?: (entry: MediaEntry) => MediaEntry;
    mediaFiles?: ReadonlyMap<string, string>; isCurrent?: () => boolean;
    assertDiskBaseline(signal: AbortSignal): Promise<void>;
}): Promise<void> {
    const { doc, signal } = options, initialRevision = doc.rev;
    const check = () => {
        signal.throwIfAborted();
        if (doc.rev !== initialRevision || options.isCurrent?.() === false) throw new Error('Board changed while recovery was being prepared');
    };
    let steps = 0, started = performance.now();
    const cooperate = async () => {
        check(); await (options.cooperate?.() ?? new Promise<void>(resolve => setTimeout(resolve, 0)));
        check(); steps = 0; started = performance.now();
    };
    const due = () => ++steps >= 256 || performance.now() - started >= 3;
    const equal = async (a: unknown, b: unknown): Promise<boolean> => {
        const pending: [unknown, unknown][] = [[a, b]];
        while (pending.length) {
            if (due()) await cooperate();
            const [left, right] = pending.pop()!;
            if (Object.is(left, right)) continue;
            if (!left || !right || typeof left !== 'object' || typeof right !== 'object') return false;
            if (left instanceof Map || right instanceof Map) {
                if (!(left instanceof Map) || !(right instanceof Map) || left.size !== right.size) return false;
                for (const [key, value] of left) {
                    if (due()) await cooperate();
                    if (!right.has(key)) return false;
                    pending.push([value, right.get(key)]);
                }
            } else if (Array.isArray(left) || Array.isArray(right)) {
                if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
                for (let i = 0; i < left.length; i++) { if (due()) await cooperate(); pending.push([left[i], right[i]]); }
            } else {
                const a = left as Record<string, unknown>, b = right as Record<string, unknown>;
                const keys = Object.keys(a), other = Object.keys(b);
                if (keys.length !== other.length) return false;
                for (const key of keys) { if (due()) await cooperate(); if (!Object.hasOwn(b, key)) return false; pending.push([a[key], b[key]]); }
            }
        }
        return true;
    };
    await cooperate();
    const bytes = await materializeBoardRecoveryRecipe(payload, signal, options.mediaFiles); check();
    const acquired = await acquireNativeBoard({ bytes, kind: doc.kind,
        identity: { session: `recovery-${crypto.randomUUID()}`, epoch: 0, generation: 0 },
        ...(doc.host.kind === 'pdf-ink' ? { pdfPages: doc.host.pages } : {}), signal, deadlineMs: 120_000, cooperate });
    try {
        check();
        if (acquired.status !== 'editable') throw new Error('Recovered board requires read-only original-byte recovery');
        const projection = acquired.report.repaired?.projection;
        if (!projection) throw new Error('Recovered board has no admitted projection');
        const target = await rehydrateLoad(projection, (pts, header) => options.samples.admitEncoded(pts, header), options.samples, cooperate, signal);
        try {
            check();
            const desired = target.doc, ops: Op[] = [];
            if (desired.kind !== doc.kind || desired.host.kind !== doc.host.kind) throw new Error('Recovery cannot replace board kind');
            if (!(await equal(doc.preserved, desired.preserved))) throw new Error('Recovery cannot overwrite preserved board metadata');
            if (doc.host.kind === 'pdf-ink' && desired.host.kind === 'pdf-ink' && !(await equal(doc.host.pages, desired.host.pages))) throw new Error('Recovery cannot replace PDF page geometry');
            const desiredMedia = new Map<MediaId, MediaEntry>();
            for (const [id, entry] of desired.media) { if (due()) await cooperate(); desiredMedia.set(id, entry); }
            if (options.projectMedia) for (const [id, entry] of desiredMedia) {
                if (due()) await cooperate();
                const projected = options.projectMedia(entry);
                if (projected.id !== id) throw new Error('Recovery media projection changed identity');
                desiredMedia.set(id, projected);
            }
            // Opaque records cannot be created, removed or edited by a transaction.
            for (const node of doc.nodes.values()) {
                if (due()) await cooperate();
                const next = desired.nodes.get(node.id);
                if (node.kind === 'opaque' || next?.kind === 'opaque') {
                    if (!next || node.kind !== 'opaque' || next.kind !== 'opaque' || !(await equal(node, next))) throw new Error(`Recovery would change opaque node ${node.id}`);
                } else if (next && next.kind !== node.kind) throw new Error(`Recovery cannot change node kind ${node.id}`);
            }
            for (const node of desired.nodes.values()) {
                if (due()) await cooperate();
                if (node.kind === 'opaque' && !doc.nodes.has(node.id)) throw new Error(`Recovery cannot create opaque node ${node.id}`);
            }
            for (const sheet of desired.sheets.values()) {
                if (due()) await cooperate();
                const old = doc.sheets.get(sheet.id);
                if (!old) {
                    if (doc.nodes.has(sheet.id as unknown as NodeId)) throw new Error('Recovery sheet identity conflicts with a current node');
                    ops.push({ t: 'sheet', op: 'create', sheet });
                } else {
                    if (old.name !== sheet.name) ops.push({ t: 'sheet', op: 'set', id: sheet.id, key: 'name', value: sheet.name });
                    if (old.order !== sheet.order) ops.push({ t: 'sheet', op: 'set', id: sheet.id, key: 'order', value: sheet.order });
                    if (old.name !== sheet.name || old.order !== sheet.order || !(await equal(old.ext, sheet.ext))) ops.push({ t: 'ext', target: 'sheet', id: sheet.id, value: sheet.ext });
                }
            }
            for (const entry of desiredMedia.values()) {
                if (due()) await cooperate();
                const old = doc.media.get(entry.id);
                if (!old) ops.push({ t: 'media', op: 'add', entry });
                else {
                    const { file: oldFile, ext: oldExt, ...oldData } = old, { file, ext, ...nextData } = entry;
                    if (!(await equal(oldData, nextData))) throw new Error(`Recovery cannot replace media metadata ${entry.id}`);
                    if (oldFile !== file) ops.push({ t: 'media', op: 'set-file', id: entry.id, file });
                    if (oldFile !== file || !(await equal(oldExt, ext))) ops.push({ t: 'ext', target: 'media', id: entry.id, value: ext });
                }
            }
            const depth = (source: BoardDoc, node: Node): number => {
                let current = node, count = 1;
                while (!source.sheets.has(current.parent as SheetId)) {
                    const parent = source.nodes.get(current.parent as NodeId);
                    if (!parent || count++ >= 64) throw new Error('Invalid recovery parent chain');
                    current = parent;
                }
                return count;
            };
            const sheetOf = (source: BoardDoc, node: Node): SheetId => {
                let current = node;
                for (let i = 0; i < 64; i++) {
                    if (source.sheets.has(current.parent as SheetId)) return current.parent as SheetId;
                    const parent = source.nodes.get(current.parent as NodeId);
                    if (!parent) break;
                    current = parent;
                }
                throw new Error('Invalid recovery parent chain');
            };
            // All changed existing parents temporarily go to their desired sheet root,
            // preventing a swapped ancestor pair from creating an intermediate cycle.
            const detached = new Set<NodeId>();
            for (const node of desired.nodes.values()) {
                if (due()) await cooperate();
                const old = doc.nodes.get(node.id);
                if (!old || old.kind === 'opaque' || old.parent === node.parent) continue;
                const root: ParentId = sheetOf(desired, node);
                if (old.parent !== root) ops.push({ t: 'set', id: node.id, key: 'parent', value: root });
                detached.add(node.id);
            }
            const removed: Node[][] = Array.from({ length: 65 }, () => []), added: Node[][] = Array.from({ length: 65 }, () => []);
            for (const node of doc.nodes.values()) {
                if (due()) await cooperate();
                if (!desired.nodes.has(node.id)) removed[depth(doc, node)].push(node);
            }
            for (let d = 64; d >= 1; d--) for (const node of removed[d]) { if (due()) await cooperate(); ops.push({ t: 'delete', id: node.id }); }
            for (const node of desired.nodes.values()) {
                if (due()) await cooperate();
                if (!doc.nodes.has(node.id)) {
                    if (doc.sheets.has(node.id as unknown as SheetId)) throw new Error('Recovery node identity conflicts with a current sheet');
                    added[depth(desired, node)].push(node);
                }
            }
            for (let d = 1; d <= 64; d++) for (const node of added[d]) { if (due()) await cooperate(); ops.push({ t: 'create', node }); }
            for (const node of desired.nodes.values()) {
                if (due()) await cooperate();
                const old = doc.nodes.get(node.id);
                if (!old || node.kind === 'opaque') continue;
                let touched = detached.has(node.id);
                if (detached.has(node.id)) ops.push({ t: 'set', id: node.id, key: 'parent', value: node.parent });
                for (const key of Object.keys(node)) {
                    if (key === 'id' || key === 'kind' || key === 'ext' || key === 'parent') continue;
                    const value = Reflect.get(node, key);
                    if (!(await equal(Reflect.get(old, key), value))) {
                        ops.push({ t: 'set', id: node.id, key, value } as Op); touched = true;
                    }
                }
                if (touched || !(await equal(old.ext, node.ext))) ops.push({ t: 'ext', target: 'node', id: node.id, value: node.ext });
            }
            const board = async (key: BoardKey, old: unknown, value: unknown) => {
                if (!(await equal(old, value))) ops.push({ t: 'board', key, value } as Op);
            };
            await board('ui.tool', doc.ui.tool, desired.ui.tool); await board('ui.next', doc.ui.next, desired.ui.next);
            await board('ui.penWidth', doc.ui.penWidth, desired.ui.penWidth);
            for (const key of ['grid', 'focusMode', 'toolLock', 'transparent', 'debugMode'] as const) await board(`view.${key}`, doc.view[key], desired.view[key]);
            if (doc.host.kind === 'notebook' && desired.host.kind === 'notebook') await board('host.paper', doc.host.paper, desired.host.paper);
            if (doc.host.kind === 'pdf-ink' && desired.host.kind === 'pdf-ink') await board('host.pdf', doc.host.pdf, desired.host.pdf);
            // Restore raw carriers after all operations that invalidate their tokens.
            ops.push({ t: 'ext', target: 'pen', value: desired.ui.ext }, { t: 'ext', target: 'view', value: desired.view.ext });
            if (desired.host.kind === 'notebook') ops.push({ t: 'ext', target: 'paper', value: desired.host.ext });
            else if (desired.host.kind === 'pdf-ink') ops.push({ t: 'ext', target: 'host', value: desired.host.ext });
            for (const sheet of doc.sheets.values()) { if (due()) await cooperate(); if (!desired.sheets.has(sheet.id)) ops.push({ t: 'sheet', op: 'delete', id: sheet.id }); }
            for (const entry of doc.media.values()) { if (due()) await cooperate(); if (!desiredMedia.has(entry.id)) ops.push({ t: 'media', op: 'drop', id: entry.id, restoreMissing: true }); }
            check();
            await options.assertDiskBaseline(signal);
            check();
            const receipt = options.apply({ origin: 'recovery', label: 'Recover unsaved changes', ops });
            receipt.release();
        } finally { target.release(); }
    } finally { acquired.dispose(); }
}
