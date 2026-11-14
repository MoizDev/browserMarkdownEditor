import type { Sheet } from './doc';
import { isValidId, type SheetId } from './ids';
import type { RawJson } from './json';
import type { LoadRepairNotice } from './loadTypes';
import { isValidKey, keysBetween } from './orderKey';

export async function repairSheets(
    sheets: readonly Sheet[], newId: () => string, options: { cooperate?: () => Promise<void>; signal?: AbortSignal },
): Promise<{ sheets: readonly Sheet[]; changedOrdinals: ReadonlySet<number>; notices: readonly LoadRepairNotice[]; readOnlyReason: string | null }> {
    const changed = new Set<number>(), messages = new Map<string, string[]>();
    const result = (records: readonly Sheet[], reason: string | null) => ({
        sheets: records, changedOrdinals: reason ? new Set<number>() : changed,
        notices: reason ? [] : [...messages].map(([code, nodeIds]) => ({ code, count: nodeIds.length, nodeIds })), readOnlyReason: reason,
    });
    const tick = async () => {
        if (options.signal?.aborted) throw new DOMException('Board admission cancelled', 'AbortError');
        if (options.cooperate) await options.cooperate();
        if (options.signal?.aborted) throw new DOMException('Board admission cancelled', 'AbortError');
    };
    await tick();
    if (sheets.length < 1 || sheets.length > 1000) return result(sheets, 'The board must have 1 to 1000 sheets');
    const reserved = new Set<string>();
    for (let i = 0; i < sheets.length; i++) {
        if ((i & 255) === 0) await tick();
        reserved.add(sheets[i].id);
    }
    const records: Sheet[] = [], seen = new Set<string>(), orders = new Set<string>();
    let badOrder = false, protectedOrder = false;
    const record = (ordinal: number, code: string, id: string) => {
        changed.add(ordinal);
        const ids = messages.get(code);
        if (ids) ids.push(id); else messages.set(code, [id]);
    };
    for (let i = 0; i < sheets.length; i++) {
        if ((i & 255) === 0) await tick();
        let sheet = sheets[i];
        if (typeof sheet.name !== 'string' || sheet.name.length > 200 || !/\S/.test(sheet.name)) {
            return result(sheets, 'A sheet has an invalid name');
        }
        if (!isValidId(sheet.id) || seen.has(sheet.id)) {
            if (sheet.ext?.raw.has('id')) return result(sheets, 'Repair would override a preserved sheet identity');
            let id = '';
            for (let attempt = 0; attempt < 1024; attempt++) {
                const candidate = newId();
                if (isValidId(candidate) && !reserved.has(candidate)) { id = candidate; break; }
            }
            if (!id) return result(sheets, 'Cannot allocate a unique sheet identity');
            reserved.add(id);
            const fields = new Map(sheet.ext?.fields);
            // Existing user metadata takes precedence over the generated inert JSON string.
            if (!fields.has('importedId')) fields.set('importedId', JSON.stringify(sheet.id) as RawJson);
            sheet = { ...sheet, id: id as SheetId, ext: { fields, raw: sheet.ext?.raw ?? new Map() } };
            record(i, 'duplicate-sheet-id', id);
        }
        seen.add(sheet.id);
        if (!isValidKey(sheet.order) || orders.has(sheet.order)) badOrder = true;
        orders.add(sheet.order);
        if (sheet.ext?.raw.has('order')) protectedOrder = true;
        records.push(sheet);
    }
    if (badOrder) {
        if (protectedOrder) return result(sheets, 'Repairing sheet order would override a preserved property');
        const keys = keysBetween(null, null, records.length);
        for (let i = 0; i < records.length; i++) {
            if ((i & 255) === 0) await tick();
            records[i] = { ...records[i], order: keys[i] };
            record(i, 'sheet-order', records[i].id);
        }
    }
    await tick();
    return result(records, null);
}
