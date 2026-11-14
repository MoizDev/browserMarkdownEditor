import { isLocked } from '../change/commands';
import { poseInParent, worldPose, type ChangeGeometry } from '../change/coordinates';
import type { NodeSetOp } from '../change/ops';
import { acquireBoardGeometryScope } from '../commands/geometryScope';
import { notebookGrowthOp } from '../commands/pagesAndSheets';
import type { BoardRuntime } from '../host/runtime';
import { sheetOf } from '../model/doc';
import type { NodeId } from '../model/ids';
import { projectBoardGeometrySets } from '../model/overlayDoc';

export interface ConnectorHeadOptions {
    readonly runtime: BoardRuntime;
    readonly id: NodeId;
    readonly terminal: 'start' | 'end';
    readonly current: () => boolean;
    readonly hold: () => () => void;
    readonly registerPending: (cancel: () => void) => () => void;
    readonly show: (ops: readonly NodeSetOp[]) => void;
    readonly waitUntilIdle: (signal: AbortSignal) => Promise<void>;
    readonly waitUntilReady: (signal: AbortSignal) => Promise<void>;
    readonly armCommit: () => void;
    readonly finishCommit: () => void;
    readonly cancelCommit: () => void;
    readonly clear: () => void;
    readonly error: (error: unknown) => void;
    readonly cooperate?: () => Promise<void>;
}

/** Endpoint double activation is a single guarded head-style transaction. */
export function toggleConnectorHead(options: ConnectorHeadOptions): boolean {
    const { runtime } = options, session = runtime.session, doc = session.doc, owner = session.owner, revision = doc.rev;
    const selection = runtime.selection.getSnapshot(), node = doc.nodes.get(options.id);
    if (!options.current() || session.isReadOnly || !node || node.kind !== 'connector' || isLocked(doc, node)
        || sheetOf(doc, node.id) !== selection.sheet || selection.selected.length !== 1 || selection.selected[0] !== node.id) return false;
    const controller = new AbortController(), release = options.hold();
    let unregister: (() => void) | undefined, font: number | undefined;
    const current = () => !controller.signal.aborted && options.current() && session.owner === owner && session.doc === doc
        && doc.rev === revision && !session.isReadOnly && runtime.selection.getSnapshot() === selection
        && (font === undefined || runtime.render.text.fonts.epoch === font);
    const check = () => { controller.signal.throwIfAborted(); if (!current()) throw new DOMException('Connector head source changed', 'AbortError'); };
    try { unregister = options.registerPending(() => controller.abort()); }
    catch (error) { release(); throw error; }
    void (async () => {
        await options.waitUntilIdle(controller.signal); check();
        const source = await acquireBoardGeometryScope(runtime, [node.id], { signal: controller.signal, current, cooperate: options.cooperate });
        try {
            check(); font = runtime.render.text.fonts.epoch;
            const key = options.terminal === 'start' ? 'headStart' : 'headEnd';
            // Default: an existing nonempty head toggles off; an empty head toggles to the ordinary arrow.
            const ops: NodeSetOp[] = [{ t: 'set', id: node.id, key, value: node[key] === 'none' ? 'arrow' : 'none' }];
            const project = (value: readonly NodeSetOp[]) => projectBoardGeometrySets(doc, value,
                { signal: controller.signal, current, cooperate: options.cooperate });
            const candidate = await project(ops); check();
            const staged = await acquireBoardGeometryScope(runtime, [node.id], { doc: candidate, signal: controller.signal, current, cooperate: options.cooperate });
            try {
                check(); const b = staged.logicalBounds(node.id), pose = worldPose(candidate, node.id);
                const geometry: ChangeGeometry = { resolvedTip: (d, connector, terminal) => runtime.render.changeGeometry.resolvedTip(d, connector, terminal),
                    worldBoundsCenter: () => ({ x: b.x + b.width / 2, y: b.y + b.height / 2 }) };
                const placement = poseInParent(doc, node, node.parent, pose, geometry);
                if (placement.page !== node.page) ops.push({ t: 'set', id: node.id, key: 'page', value: placement.page });
                if (placement.x !== node.x) ops.push({ t: 'set', id: node.id, key: 'x', value: placement.x });
                if (placement.y !== node.y) ops.push({ t: 'set', id: node.id, key: 'y', value: placement.y });
            } finally { staged.release(); }
            const finalDoc = await project(ops); check();
            const final = await acquireBoardGeometryScope(runtime, [node.id], { doc: finalDoc, signal: controller.signal, current, cooperate: options.cooperate });
            try {
                check(); const b = final.logicalBounds(node.id), growth = notebookGrowthOp(doc, b.y + b.height);
                options.show(ops); await options.waitUntilReady(controller.signal); check();
                options.armCommit();
                try {
                    const applied = session.apply({ origin: 'tool', label: 'Toggle connector head', ops: [...(growth ? [growth] : []), ...ops] });
                    applied.release(); options.finishCommit();
                } catch (error) { options.cancelCommit(); throw error; }
            } finally { final.release(); }
        } finally { source.release(); }
    })().catch(error => {
        if (!controller.signal.aborted && !(error instanceof DOMException && error.name === 'AbortError')) options.error(error);
    }).finally(() => {
        try { options.clear(); } finally { try { unregister?.(); } finally { release(); } }
    }).catch(options.error);
    return true;
}
