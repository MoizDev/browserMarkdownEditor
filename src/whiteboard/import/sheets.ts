import type { Sheet } from '../model/doc';
import { isValidKey, keysBetween } from '../model/orderKey';
import { ReportBuilder } from './report';

export function repairLegacySheets(sheets: readonly Sheet[], report: ReportBuilder): readonly Sheet[] {
    const byOrder = sheets.slice().sort((a, b) => a.order < b.order ? -1 : a.order > b.order ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
    const keys = byOrder.some(sheet => !isValidKey(sheet.order)) ? keysBetween(null, null, byOrder.length) : null;
    if (keys) report.repair(null, 'Invalid sheet order keys regenerated');
    return byOrder.map((sheet, index) => {
        let name = sheet.name;
        if (!name.trim()) { name = `Page ${index + 1}`; report.repair(sheet.id, 'Blank sheet name repaired'); }
        if (name.length > 200) {
            // Truncation would erase user content, so retain the original in the source and refuse saving.
            report.refuse(sheet.id, 'Sheet name exceeds the model limit');
            name = name.slice(0, 200);
        }
        return { ...sheet, name, order: keys?.[index] ?? sheet.order };
    });
}
