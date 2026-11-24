import type { ReadIssue, ReadSourceRecord } from '../format/readTypes';
import type { BoardDocInput, Sheet } from './doc';
import { createLoadedBoardDoc } from './loadDocument';
import { recountLoadMedia } from './loadMediaCounts';
import { repairGraph } from './repairGraph';
import { repairLoadIdentities } from './repairIdentities';
import { projectLoad, rehydrateLoad } from './loadProjection';
import { repairNodeValues } from './repairValues';
import { repairNodeText } from './repairText';
import { repairSheets } from './repairSheets';
import type { LoadRepairDraft, LoadRepairNotice, LoadRepairOptions, LoadRepairPort, LoadRepairResult } from './loadTypes';
import type { MediaEntry } from './media';
import { isValidId } from './ids';
import type { NodeRecord } from './nodes';
import { validateLoadedNode, validateLoadedRootIncremental } from './validate';
import { yieldToHost } from '../../platform/yieldToHost';

async function ordered<T>(values: Iterable<T>, options: LoadRepairOptions): Promise<T[]> {
    const records: T[] = [];
    for (const value of values) {
        if ((records.length & 255) === 0) { options.signal?.throwIfAborted(); await options.cooperate?.(); }
        records.push(value);
    }
    options.signal?.throwIfAborted();
    return records;
}

/** Repair is history-silent. Re-encoding flags and deleted-source tombstones are
 * preparation for the first user edit, not a write or a dirty admission itself. */
export async function repairLoad(draft: LoadRepairDraft, options: LoadRepairOptions): Promise<LoadRepairResult> {
    options = { ...options, cooperate: options.cooperate ?? yieldToHost };
    const sheets = await ordered<Sheet>(draft.input.sheets, options), nodes = await ordered<NodeRecord>(draft.input.nodes ?? [], options);
    const sourceMedia = await ordered<MediaEntry>(draft.input.media ?? [], options), media: MediaEntry[] = [], notices: LoadRepairNotice[] = [], issues: ReadIssue[] = [];
    const refuse = (reason: string): LoadRepairResult => ({ status: 'read-only', projection: null, repairs: notices,
        issues: [...issues, { code: 'repair', reason, readOnly: true }] });
    const singletonSources = new Set<string>();
    for (let i = 0; i < draft.sources.length; i++) {
        if ((i & 255) === 0) { options.signal?.throwIfAborted(); await options.cooperate?.(); }
        const source = draft.sources[i];
        if (!['pen', 'view', 'paper', 'host', 'end'].includes(source.category)) continue;
        if (singletonSources.has(source.category)) return refuse(`Duplicate ${source.category} records require original-byte recovery`);
        singletonSources.add(source.category);
    }
    const reserved = new Set<string>();
    for (let i = 0; i < nodes.length; i++) {
        if ((i & 255) === 0) { options.signal?.throwIfAborted(); await options.cooperate?.(); }
        reserved.add(nodes[i].id);
    }
    for (const sheet of sheets) reserved.add(sheet.id);
    const newId = () => {
        const id = options.newId();
        if (!isValidId(id) || reserved.has(id)) return '';
        reserved.add(id);
        return id;
    };
    const identities = await repairLoadIdentities(sheets, nodes, draft.sources, newId, options);
    notices.push(...identities.notices);
    if (identities.readOnlyReason) return refuse(identities.readOnlyReason);
    const sheetRepair = await repairSheets(identities.sheets, newId, options);
    notices.push(...sheetRepair.notices);
    if (sheetRepair.readOnlyReason) return refuse(sheetRepair.readOnlyReason);
    const mediaById = new Map<string, MediaEntry>(), duplicateMedia = new Set<number>();
    let mediaWork = 0;
    const sameMap = async (a: ReadonlyMap<string, string> | undefined, b: ReadonlyMap<string, string> | undefined) => {
        if ((a?.size ?? 0) !== (b?.size ?? 0)) return false;
        if (a) for (const [key, value] of a) {
            if ((mediaWork++ & 255) === 0) { options.signal?.throwIfAborted(); await options.cooperate?.(); }
            if (b?.get(key) !== value) return false;
        }
        return true;
    };
    for (let i = 0; i < sourceMedia.length; i++) {
        if ((i & 255) === 0) { options.signal?.throwIfAborted(); await options.cooperate?.(); }
        const entry = sourceMedia[i], first = mediaById.get(entry.id);
        if (!first) { mediaById.set(entry.id, entry); media.push(entry); continue; }
        // Only identical records collapse; conflicting metadata has no lossless winner.
        if (entry.mime !== first.mime || entry.bytes !== first.bytes || entry.w !== first.w || entry.h !== first.h
            || entry.duration !== first.duration || entry.animated !== first.animated || entry.name !== first.name || entry.file !== first.file
            || !(await sameMap(entry.ext?.fields, first.ext?.fields)) || !(await sameMap(entry.ext?.raw, first.ext?.raw))) {
            return refuse('Conflicting duplicate media records require original-byte recovery');
        }
        duplicateMedia.add(i);
    }
    if (duplicateMedia.size) notices.push({ code: 'duplicate-media', count: duplicateMedia.size, nodeIds: [] });
    // Repair local values before group composition: NaN/Infinity must not spread
    // from a malformed container into an otherwise valid child transform.
    const values = await repairNodeValues(identities.nodes, media, options);
    notices.push(...values.notices);
    if (values.readOnlyReason) return refuse(values.readOnlyReason);
    const text = await repairNodeText(values.nodes, options);
    notices.push(...text.notices);
    if (text.readOnlyReason) return refuse(text.readOnlyReason);
    const nodeSources: ReadSourceRecord[] = [];
    for (let i = 0; i < draft.sources.length; i++) {
        if ((i & 255) === 0) { options.signal?.throwIfAborted(); await options.cooperate?.(); }
        if (draft.sources[i].category === 'node') nodeSources.push(draft.sources[i]);
    }
    const graph = await repairGraph({ kind: draft.input.kind, sheets: sheetRepair.sheets, nodes: text.nodes, newId,
        rootPlacement: (node, sheet, index) => options.rootPlacement(node, sheet, nodeSources[index]?.position.ordinal ?? index),
        cooperate: options.cooperate, signal: options.signal });
    notices.push(...graph.notices);
    if (graph.readOnlyReason) return refuse(graph.readOnlyReason);
    const repaired: BoardDocInput = { ...draft.input, sheets: sheetRepair.sheets, nodes: graph.nodes, media };
    const counts = await recountLoadMedia(repaired, options.cooperate, options.signal);
    const input: BoardDocInput = { ...repaired, preservedMediaRefs: counts };
    const doc = await createLoadedBoardDoc(input, options.cooperate, options.signal);
    const root = await validateLoadedRootIncremental(doc, options.cooperate, options.signal);
    if (!root.ok) return refuse(root.reason);
    let index = 0;
    for (const node of graph.nodes) {
        if ((index & 255) === 0) { options.signal?.throwIfAborted(); await options.cooperate?.(); }
        const check = validateLoadedNode({ doc, samples: options.samples }, node, index++);
        if (!check.ok) return refuse(`Node ${node.id}: ${check.reason}`);
    }
    const surviving = new Map<number, NodeRecord>(), liveNodeIds = new Set<string>();
    for (let i = 0; i < graph.nodes.length; i++) {
        if ((i & 255) === 0) { options.signal?.throwIfAborted(); await options.cooperate?.(); }
        surviving.set(graph.sourceOrdinals[i], graph.nodes[i]); liveNodeIds.add(graph.nodes[i].id);
    }
    let nodeOrdinal = 0, sheetOrdinal = 0, mediaOrdinal = 0;
    const sources: ReadSourceRecord[] = [], removedSources: ReadSourceRecord[] = [...draft.removedSources ?? []];
    for (let i = 0; i < draft.sources.length; i++) {
        if ((i & 255) === 0) { options.signal?.throwIfAborted(); await options.cooperate?.(); }
        const source = draft.sources[i];
        if (source.category === 'node') {
            const ordinal = nodeOrdinal++, node = surviving.get(ordinal);
            if (!node) {
                if (source.id !== undefined && !liveNodeIds.has(source.id)) removedSources.push(source);
                continue;
            }
            const changed = source.reencode || identities.changedNodeOrdinals.has(ordinal) || values.changedOrdinals.has(ordinal) || text.changedOrdinals.has(ordinal) || graph.changedOrdinals.has(ordinal);
            sources.push(changed ? { ...source, id: node.id, reencode: true } : source);
        } else if (source.category === 'sheet') {
            const ordinal = sheetOrdinal++, sheet = sheetRepair.sheets[ordinal];
            sources.push(identities.changedSheetOrdinals.has(ordinal) || sheetRepair.changedOrdinals.has(ordinal) ? { ...source, id: sheet.id, reencode: true } : source);
        } else if (source.category === 'media') {
            const ordinal = mediaOrdinal++, entry = sourceMedia[ordinal];
            if (!entry || source.id !== entry.id || source.type !== 'media') return refuse('Media source identity does not match its decoded record');
            if (!duplicateMedia.has(ordinal)) sources.push(source);
        } else sources.push(source);
    }
    const projection = await projectLoad({ input, sources, removedSources, unmapped: draft.unmapped,
        ...(draft.savedView ? { savedView: draft.savedView } : {}) }, options.sampleWire, options.cooperate, options.signal);
    return { status: 'editable', projection, repairs: notices, issues };
}
export const loadRepairPort: LoadRepairPort = { repair: repairLoad, rehydrate: rehydrateLoad };
