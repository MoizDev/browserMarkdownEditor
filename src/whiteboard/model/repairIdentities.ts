import type { ReadSourceRecord } from '../format/readTypes';
import type { Sheet } from './doc';
import { isValidId, type NodeId, type SheetId } from './ids';
import type { RawJson } from './json';
import type { LoadRepairNotice } from './loadTypes';
import type { NodeRecord } from './nodes';

// Provenance: document-model V-1/§9.2 and ordered native source records;
// independent cooperative merge sort, no third-party source.
type Candidate = { readonly category: 'sheet' | 'node'; readonly index: number; readonly ordinal: number };
export async function repairLoadIdentities(sheets: readonly Sheet[], nodes: readonly NodeRecord[],
    sources: readonly ReadSourceRecord[], newId: () => string, options: { cooperate?: () => Promise<void>; signal?: AbortSignal }): Promise<{
        sheets: readonly Sheet[]; nodes: readonly NodeRecord[]; changedSheetOrdinals: ReadonlySet<number>;
        changedNodeOrdinals: ReadonlySet<number>; notices: readonly LoadRepairNotice[]; readOnlyReason: string | null;
    }> {
    let steps = 0, started = performance.now();
    const check = () => { if (options.signal?.aborted) throw new DOMException('Board admission cancelled', 'AbortError'); };
    const tick = async () => {
        check();
        await (options.cooperate?.() ?? new Promise<void>(resolve => setTimeout(resolve, 0)));
        check(); steps = 0; started = performance.now();
    };
    const due = () => ++steps >= 256 || performance.now() - started >= 3;
    const refusal = (reason: string) => ({ sheets, nodes, changedSheetOrdinals: new Set<number>(),
        changedNodeOrdinals: new Set<number>(), notices: [] as LoadRepairNotice[], readOnlyReason: reason });
    await tick();
    const reserved = new Set<string>(), sheetResult: Sheet[] = [], nodeResult: NodeRecord[] = [];
    for (const sheet of sheets) {
        if (due()) await tick();
        if (typeof sheet.id !== 'string') return refusal('Sheet identity is not a string');
        reserved.add(sheet.id); sheetResult.push(sheet);
    }
    for (const node of nodes) {
        if (due()) await tick();
        if (typeof node.id !== 'string') return refusal('Node identity is not a string');
        reserved.add(node.id); nodeResult.push(node);
    }
    let sheetCount = 0, nodeCount = 0;
    let candidates: Candidate[] = [];
    for (const source of sources) {
        if (due()) await tick();
        if (source.category !== 'sheet' && source.category !== 'node') continue;
        const index = source.category === 'sheet' ? sheetCount++ : nodeCount++;
        if (index >= (source.category === 'sheet' ? sheets.length : nodes.length)
            || !Number.isSafeInteger(source.position.ordinal) || source.position.ordinal < 0) return refusal('Source records do not match identity records');
        candidates.push({ category: source.category, index, ordinal: source.position.ordinal });
    }
    // A stable bottom-up merge avoids native sort's uninterruptible million-record turn.
    let target = new Array<Candidate>(candidates.length);
    for (let width = 1; width < candidates.length; width *= 2) {
        for (let start = 0; start < candidates.length; start += 2 * width) {
            const mid = Math.min(start + width, candidates.length), end = Math.min(start + 2 * width, candidates.length);
            let left = start, right = mid;
            for (let i = start; i < end; i++) {
                if (due()) await tick();
                target[i] = right >= end || (left < mid && candidates[left].ordinal <= candidates[right].ordinal)
                    ? candidates[left++] : candidates[right++];
            }
        }
        [candidates, target] = [target, candidates];
    }
    for (let i = sheetCount; i < sheets.length; i++) { if (due()) await tick(); candidates.push({ category: 'sheet', index: i, ordinal: 0 }); }
    for (let i = nodeCount; i < nodes.length; i++) { if (due()) await tick(); candidates.push({ category: 'node', index: i, ordinal: 0 }); }
    const seen = new Set<string>(), changedSheetOrdinals = new Set<number>(), changedNodeOrdinals = new Set<number>();
    const notices = new Map<string, string[]>();
    for (const item of candidates) {
        if (due()) await tick();
        const record = item.category === 'sheet' ? sheetResult[item.index] : nodeResult[item.index];
        const original = record.id;
        if (isValidId(original) && !seen.has(original)) { seen.add(original); continue; }
        if (item.category === 'node' && (record as NodeRecord).kind === 'opaque') return refusal('An opaque record has a duplicate or invalid identity');
        if (record.ext?.raw.has('id')) return refusal('Repair would override a preserved identity');
        let replacement: string | undefined;
        for (let attempt = 0; attempt < 1024; attempt++) {
            if (due()) await tick();
            const candidate = newId();
            if (typeof candidate === 'string' && isValidId(candidate) && !reserved.has(candidate)) { replacement = candidate; break; }
        }
        if (replacement === undefined) return refusal('Cannot allocate a unique record identity');
        reserved.add(replacement); seen.add(replacement);
        const fields = new Map<string, RawJson>();
        if (record.ext) for (const [key, value] of record.ext.fields) {
            if (due()) await tick();
            fields.set(key, value);
        }
        if (!fields.has('importedId')) fields.set('importedId', JSON.stringify(original) as RawJson);
        const ext = { fields, raw: record.ext?.raw ?? new Map() };
        const code = item.category === 'sheet' ? 'duplicate-sheet-id' : 'duplicate-id';
        if (item.category === 'sheet') {
            sheetResult[item.index] = { ...sheetResult[item.index], id: replacement as SheetId, ext };
            changedSheetOrdinals.add(item.index);
        } else {
            nodeResult[item.index] = { ...nodeResult[item.index], id: replacement as NodeId, ext };
            changedNodeOrdinals.add(item.index);
        }
        const list = notices.get(code);
        if (list) list.push(replacement); else notices.set(code, [replacement]);
    }
    check();
    return { sheets: sheetResult, nodes: nodeResult, changedSheetOrdinals, changedNodeOrdinals,
        notices: [...notices].map(([code, nodeIds]) => ({ code, count: nodeIds.length, nodeIds })), readOnlyReason: null };
}
