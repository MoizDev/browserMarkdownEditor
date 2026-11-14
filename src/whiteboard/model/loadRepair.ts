import type { ReadIssue, ReadSourceRecord } from '../format/readTypes';
import { createBoardDoc } from './doc';
import type { BoardDocInput } from './doc';
import type { MediaId } from './media';
import { extRawValues, hostRawValues, nodeRawValues, preservedRawValues, scanRawMedia } from './rawMedia';
import { repairGraph } from './repairGraph';
import { projectLoad, rehydrateLoad } from './loadProjection';
import type { LoadRepairDraft, LoadRepairOptions, LoadRepairPort, LoadRepairResult } from './loadTypes';
import { validateLoadedNode } from './validate';

/** Repair stays history-silent and never writes. A read-only result leaves source
 * bytes authoritative; no partially repaired projection becomes editable. */
export async function repairLoad(draft: LoadRepairDraft, options: LoadRepairOptions): Promise<LoadRepairResult> {
    const sheets = Array.from(draft.input.sheets), nodes = Array.from(draft.input.nodes ?? []), media = Array.from(draft.input.media ?? []);
    const nodeSources = draft.sources.filter(source => source.category === 'node');
    const graph = await repairGraph({ kind: draft.input.kind, sheets, nodes, newId: options.newId,
        rootPlacement: (node, sheet, index) => options.rootPlacement(node, sheet, nodeSources[index]?.position.ordinal ?? index),
        cooperate: options.cooperate, signal: options.signal });
    const issues: ReadIssue[] = [];
    const refuse = (reason: string): LoadRepairResult => ({ status: 'read-only', projection: null, repairs: graph.notices,
        issues: [...issues, { code: 'repair', reason, readOnly: true }] });
    if (graph.readOnlyReason) return refuse(graph.readOnlyReason);
    const ids = new Set<string>();
    for (const sheet of sheets) {
        if (ids.has(sheet.id)) return refuse('Duplicate sheet identity requires read-only recovery');
        ids.add(sheet.id);
    }
    const mediaIds = new Set<MediaId>();
    for (const entry of media) {
        if (mediaIds.has(entry.id)) return refuse('Duplicate media identity requires read-only recovery');
        mediaIds.add(entry.id);
    }
    // Recount from the retained repaired carriers. Per-RawJson scans deduplicate
    // occurrences within the raw value, not across separate carrier locations.
    const counts = new Map<MediaId, number>();
    const add = (id: MediaId) => counts.set(id, (counts.get(id) ?? 0) + 1);
    for (const raw of preservedRawValues(draft.input.preserved)) scanRawMedia(raw, add);
    for (const raw of hostRawValues(draft.input.host)) scanRawMedia(raw, add);
    for (const raw of extRawValues(draft.input.ui.ext)) scanRawMedia(raw, add);
    for (const raw of extRawValues(draft.input.view.ext)) scanRawMedia(raw, add);
    for (const sheet of sheets) for (const raw of extRawValues(sheet.ext)) scanRawMedia(raw, add);
    for (const entry of media) for (const raw of extRawValues(entry.ext)) scanRawMedia(raw, id => { if (id !== entry.id) add(id); });
    for (let i = 0; i < graph.nodes.length; i++) {
        if ((i & 1023) === 0) {
            if (options.signal?.aborted) throw new DOMException('Board admission cancelled', 'AbortError');
            await options.cooperate?.();
        }
        for (const raw of nodeRawValues(graph.nodes[i])) if (raw !== null) scanRawMedia(raw, add);
    }
    const input: BoardDocInput = { ...draft.input, sheets, nodes: graph.nodes, media, preservedMediaRefs: counts };
    const doc = createBoardDoc(input);
    let index = 0;
    for (const node of doc.nodes.values()) {
        if ((index & 1023) === 0) {
            if (options.signal?.aborted) throw new DOMException('Board admission cancelled', 'AbortError');
            await options.cooperate?.();
        }
        const check = validateLoadedNode({ doc, samples: options.samples }, node, index++);
        if (!check.ok) return refuse(`Node ${node.id}: ${check.reason}`);
    }
    let nodeOrdinal = 0;
    const sources: ReadSourceRecord[] = draft.sources.map(source => {
        if (source.category !== 'node') return source;
        const changed = graph.changedOrdinals.has(nodeOrdinal++);
        return changed ? { ...source, reencode: true } : source;
    });
    const projection = await projectLoad({ input, sources, unmapped: draft.unmapped, ...(draft.savedView ? { savedView: draft.savedView } : {}) },
        options.sampleWire, options.cooperate, options.signal);
    return { status: 'editable', projection, repairs: graph.notices, issues };
}
export const loadRepairPort: LoadRepairPort = { repair: repairLoad, rehydrate: rehydrateLoad };
