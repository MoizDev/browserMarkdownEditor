import type { RenderToken } from '../../platform/render/types';
import { worldPose } from '../change/coordinates';
import { acquireBoardGeometryProjection, type BoardGeometryScope } from '../commands/geometryScope';
import { createAgentProjection } from '../agent/projection';
import type { AgentGeometry } from '../agent/shapes';
import type { SampleStore } from '../ink/samples';
import { MediaStore } from '../media/store';
import type { BoardDoc } from '../model/doc';
import type { Node } from '../model/nodes';
import { createBoardRenderServices } from '../render/services';

export interface AgentGeometryReader {
    readonly geometry: AgentGeometry;
    prepare(node: Node): Promise<void>;
    dispose(): void;
}

export function createAgentGeometryReader(options: {
    readonly doc: BoardDoc;
    readonly samples: SampleStore;
    readonly token: RenderToken;
    readonly signal: AbortSignal;
    readonly render?: ReturnType<typeof createBoardRenderServices>;
    readonly cooperate: () => Promise<void>;
    isCurrent(): boolean;
}): AgentGeometryReader {
    const { doc, samples, token, signal } = options;
    const revision = doc.rev;
    const media = options.render ? undefined : new MediaStore();
    const render = options.render ?? createBoardRenderServices({ doc, samples, media: media!, token });
    let disposed = false, generation = 0, scope: BoardGeometryScope | undefined, row: Node | undefined;
    let empty: { x: number; y: number; w: number; h: number } | undefined;
    const guard = (node?: Node) => {
        signal.throwIfAborted();
        if (disposed || !options.isCurrent() || doc.rev !== revision || (node && doc.nodes.get(node.id) !== node))
            throw new DOMException('Agent geometry source changed', 'AbortError');
        if (node && row !== node) throw new Error('Agent geometry row has not been prepared');
    };
    const projection = createAgentProjection(doc, {
        worldBox(node) {
            guard(node);
            if (empty) return { ...empty };
            const b = scope!.logicalBounds(node.id);
            return { x: b.x, y: b.y, w: b.width, h: b.height };
        },
        localBox(node) {
            guard(node);
            if (empty) return { x: 0, y: 0, w: 0, h: 0 };
            const b = scope!.localBounds(node.id);
            return { x: b[0], y: b[1], w: b[2] - b[0], h: b[3] - b[1] };
        },
        resolvedTip(candidate, connector, end) {
            guard(connector);
            return scope!.geometry.resolvedTip(candidate, connector, end);
        },
        resolvedPolylineTip(candidate, polyline, end) {
            guard();
            return scope!.geometry.resolvedPolylineTip(candidate, polyline, end);
        },
    });
    return {
        geometry: projection.geometry,
        async prepare(node) {
            guard();
            if (doc.nodes.get(node.id) !== node) throw new Error('Agent row is not part of the captured document');
            const request = ++generation;
            scope?.release(); scope = undefined; row = undefined; empty = undefined;
            if (node.kind === 'group') {
                const pending: Node[] = [node];
                let leaf = false, work = 0;
                while (pending.length) {
                    const value = pending.pop()!;
                    if (value.kind !== 'group') { leaf = true; break; }
                    for (const child of doc.children.get(value.id) ?? []) pending.push(child);
                    if (++work % 256 === 0) { await options.cooperate(); guard(); }
                }
                if (!leaf) {
                    guard();
                    if (request !== generation) throw new DOMException('Agent row was superseded', 'AbortError');
                    const pose = worldPose(doc, node.id);
                    empty = { x: pose.x, y: pose.y, w: 0, h: 0 }; row = node;
                    return;
                }
            }
            const prepared = await acquireBoardGeometryProjection({ doc, render,
                isCurrent: () => !disposed && request === generation && options.isCurrent() && doc.rev === revision }, [node.id],
            { signal, current: () => !disposed && request === generation && options.isCurrent(), cooperate: options.cooperate });
            try {
                guard();
                if (request !== generation) throw new DOMException('Agent row was superseded', 'AbortError');
                scope = prepared; row = node;
            } catch (error) { prepared.release(); throw error; }
        },
        dispose() {
            if (disposed) return;
            disposed = true; generation++; row = undefined; empty = undefined;
            try { scope?.release(); } finally {
                scope = undefined;
                if (!options.render) { try { render.dispose(); } finally { media!.clear(); } }
            }
        },
    };
}
