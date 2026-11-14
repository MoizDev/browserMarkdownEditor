import type { BoardOp } from '../change/ops';
import type { BoardSession } from '../session/BoardSession';
import type { BoardViewFlags } from './preferences';

/** Apply the normal non-history view ops; PDF view-only persistence belongs to the host record. */
export function applyBoardViewFlags(
    session: BoardSession,
    next: BoardViewFlags,
    persistPdfView: (flags: BoardViewFlags) => void,
): void {
    const current = session.doc.view;
    const ops: BoardOp[] = [];
    if (current.grid !== next.grid) ops.push({ t: 'board', key: 'view.grid', value: next.grid });
    if (current.focusMode !== next.focusMode) ops.push({ t: 'board', key: 'view.focusMode', value: next.focusMode });
    if (current.toolLock !== next.toolLock) ops.push({ t: 'board', key: 'view.toolLock', value: next.toolLock });
    if (current.transparent !== next.transparent) ops.push({ t: 'board', key: 'view.transparent', value: next.transparent });
    if (current.debugMode !== next.debugMode) ops.push({ t: 'board', key: 'view.debugMode', value: next.debugMode });
    if (!ops.length) return;
    const applied = session.apply({ ops, origin: 'host', label: 'Change board view' });
    applied.release();
    if (session.doc.kind === 'pdf-ink') persistPdfView(next);
}
