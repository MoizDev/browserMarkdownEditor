import type { Node, StrokeNode } from '../model/nodes';
import type { SampleRef } from '../model/samples';
import { encodeLegacySample } from './sampleWire';
import type { LegacyLoadAdapterOptions, LegacyLoadAdmit } from './loadAdapterTypes';

// C5 owns validation/repair; the original ordered arrays reach it before any table deduplication.
export function createLegacyLoadAdapter(options: LegacyLoadAdapterOptions): LegacyLoadAdmit {
    return async (input, samples, root, report) => {
        const sheets = Array.from(input.sheets), nodes = Array.from(input.nodes ?? []), media = Array.from(input.media ?? []);
        const ids = new Set<string>([...sheets.map(sheet => sheet.id), ...nodes.map(node => node.id)]);
        const strokes = new Map<SampleRef, StrokeNode>();
        for (const node of nodes) {
            if (node.kind !== 'stroke') continue;
            const old = strokes.get(node.samples);
            strokes.set(node.samples, old ? { ...old, sx: Math.max(Math.abs(old.sx), Math.abs(node.sx)),
                sy: Math.max(Math.abs(old.sy), Math.abs(node.sy)) } : node);
        }
        let nextId = 0;
        const result = await options.port.repair({ input: { ...input, sheets, nodes, media }, sources: [], unmapped: [] }, {
            samples,
            newId() {
                let id: string;
                do { id = `legacy-repair-${++nextId}`; } while (ids.has(id));
                ids.add(id);
                return id;
            },
            sampleWire(ref) {
                const node = strokes.get(ref);
                if (!node) throw new Error('Imported stroke sample has no owner');
                return encodeLegacySample(node, samples, options.declaredMaxScale);
            },
            rootPlacement(node: Node) { return root(node); },
            cooperate: options.cooperate,
            signal: options.signal,
        });
        for (const notice of result.repairs) {
            for (let i = 0; i < notice.count; i++) report.repair(notice.nodeIds[i] ?? null, notice.code);
        }
        for (const issue of result.issues) {
            if (issue.readOnly) report.refuse(null, issue.reason);
            else report.repair(null, issue.reason);
        }
        if ((result.status === 'read-only' || result.projection === null) && !result.issues.some(issue => issue.readOnly)) {
            report.refuse(null, 'Imported document requires read-only recovery');
        }
        return result;
    };
}
