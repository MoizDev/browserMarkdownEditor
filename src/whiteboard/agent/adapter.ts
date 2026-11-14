import type { CanvasOp } from '../../../shared/vaultAgentProtocol';
import type { ChangeGeometry } from '../change/coordinates';
import { planDelete } from '../commands/delete';
import type { SampleBuilder } from '../ink/samples';
import type { SheetId } from '../model/ids';
import type { Node, Point } from '../model/nodes';
import type { SampleLease } from '../model/samples';
import type { BoardSession } from '../session/BoardSession';
import { planAgentPlacement, type LocalBox } from './placement';
import { listAgentShapes, type AgentGeometry, type ShapePage, type ShapeQuery, type ShapeSummary } from './shapes';
import { stageAgentOp } from './stage';
import { applyAgentOperations, type AgentApplyResult } from './transaction';

export interface AgentAdapterHost {
    readonly session: BoardSession;
    readonly geometry: AgentGeometry;
    sheet(): SheetId;
    /** Current visible physical page, zero-based. */
    page(): number;
    isCurrent(): boolean;
    readOnlyReason(): string | null;
    admitSamples(builder: SampleBuilder): SampleLease;
    target(node: Node, page: number): Point;
    localBox(node: Node): LocalBox;
    readonly changeGeometry: ChangeGeometry;
}
export interface AgentGuard { readonly signal?: AbortSignal; isCurrent(): boolean }
export interface BoardAgentAdapter {
    shapes(page?: number): ShapeSummary[];
    shapePage(query?: ShapeQuery): ShapePage;
    currentPage(): number;
    apply(ops: CanvasOp[], guard?: AgentGuard): Promise<AgentApplyResult>;
}

/** One adapter belongs to the App-owned session, not to a mounted view. */
export function createBoardAgentAdapter(host: AgentAdapterHost): BoardAgentAdapter {
    const shapePage = (query: ShapeQuery = {}) => {
        if (!host.isCurrent()) throw new Error('Board session is no longer current');
        return listAgentShapes(host.session.doc, host.sheet(), host.geometry, query);
    };
    return {
        shapePage,
        shapes: page => shapePage({ page }).shapes,
        currentPage: () => host.page() + 1,
        apply: (ops, guard) => {
            const signal = guard?.signal ?? new AbortController().signal;
            return applyAgentOperations({ session: host.session,
                isCurrent: () => host.isCurrent() && (guard?.isCurrent() ?? true),
                readOnlyReason: () => host.readOnlyReason(),
                stage: (op, context) => stageAgentOp({ doc: host.session.doc, sheet: host.sheet(), currentPage: host.page(),
                    admitSamples: builder => host.admitSamples(builder),
                    target: (node, page) => host.target(node, page),
                    placement: (node, update) => planAgentPlacement(node, update, { doc: host.session.doc,
                        sheet: host.sheet(), currentPage: host.page(), builder: context.builder, localBox: candidate => host.localBox(candidate) }),
                    delete: (id, builder) => planDelete(host.session.doc, builder, host.sheet(), [id], host.changeGeometry) }, op, context),
            }, ops, signal);
        },
    };
}
