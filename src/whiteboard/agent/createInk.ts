import type { CanvasOp } from '../../../shared/vaultAgentProtocol';
import { allocateOrderKeys } from '../change/commands';
import { styleGeometryMetrics } from '../geom/styleMetrics';
import { SampleBuilder } from '../ink/samples';
import { childrenOf } from '../model/doc';
import { newNodeId, type NodeId } from '../model/ids';
import { createConnector, createStroke, type ConnectorEnd, type Point } from '../model/nodes';
import type { SampleLease } from '../model/samples';
import { createPage, plainRichText, type CreateContext, type CreatedShape } from './create';
import { AgentOpRefused } from './errors';

export type InkCreate = Extract<CanvasOp, { op: 'create'; type: 'arrow' | 'draw' }>;
export interface InkCreateContext extends CreateContext {
    /** Resolves an existing, same-sheet target in the destination page's coordinates. */
    target(reference: string, page: number): { readonly id: NodeId; readonly center: Point };
    /** The session's own sample store admits the sealed builder with one caller lease. */
    admit(builder: SampleBuilder): SampleLease;
}

export function stageInkCreate(op: InkCreate, context: InkCreateContext): CreatedShape {
    const { doc, sheet, builder } = context;
    if (!doc.sheets.has(sheet)) throw new AgentOpRefused('sheet no longer exists');
    const target = createPage(context, op.page);
    const id = newNodeId(doc), siblings = childrenOf(doc, sheet);
    const order = allocateOrderKeys(doc, builder, sheet, siblings.at(-1)?.id ?? null, null, 1)[0];
    const base = { id, parent: sheet, order, page: target.page, ext: null };
    if (op.type === 'arrow') {
        const end = (value: typeof op.start): ConnectorEnd => {
            if ('x' in value) return { ...target.clamp(value), attach: null };
            const resolved = context.target(value.shapeId, target.page);
            return { ...resolved.center, attach: { target: resolved.id, anchor: { x: 0.5, y: 0.5 },
                exact: false, precise: false, snap: 'edge' } };
        };
        const start = end(op.start), finish = end(op.end);
        if (start.attach && finish.attach && start.attach.target === finish.attach.target) throw new AgentOpRefused('connector cannot bind both ends to the same shape');
        const size = op.size ?? 'm';
        const node = createConnector({ ...base, x: 0, y: 0, route: 'arc', start, end: finish, bend: op.bend ?? 0,
            color: op.color ?? 'black', labelColor: 'black', fill: 'none', dash: op.dash ?? 'solid', size,
            font: 'draw', label: op.text ? plainRichText(op.text) : null,
            width: styleGeometryMetrics.actualWidth('connector', size, 1) });
        builder.push({ t: 'create', node });
    } else {
        const points = op.points.map(p => ({ ...target.clamp({ x: p[0], y: p[1] }), p: p[2] }));
        const origin = points[0], pressure = points.some(p => p.p !== undefined);
        const samples = new SampleBuilder({ pressure, declaredMaxScale: 1, precision: 'float64' });
        const add = (x: number, y: number, p: number | undefined) => samples.append(x - origin.x, y - origin.y, pressure ? p ?? 0.5 : undefined);
        add(origin.x, origin.y, origin.p);
        for (let i = 1; i < points.length; i++) {
            const a = points[i - 1], b = points[i];
            const steps = Math.min(64, Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / 8)));
            for (let j = 1; j <= steps; j++) {
                const t = j / steps;
                add(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t,
                    pressure ? (a.p ?? 0.5) + ((b.p ?? 0.5) - (a.p ?? 0.5)) * t : undefined);
            }
        }
        const lease = context.admit(samples);
        try {
            const width = styleGeometryMetrics.actualWidth('stroke:pen', op.size ?? 's', 1);
            const node = createStroke({ ...base, x: origin.x, y: origin.y, tool: 'pen', samples: lease.ref,
                pressure: pressure ? 'real' : 'none', widthModel: pressure ? { id: 'pressure-linear-v1', rMin: 0, rMax: width / 2 } : { id: 'uniform' },
                geomVersion: 1, fairTol: 0, closed: op.closed ?? false, width, color: op.color ?? 'black' });
            builder.push({ t: 'create', node });
        } finally { lease.release(); }
    }
    return { id, notes: target.notes };
}
