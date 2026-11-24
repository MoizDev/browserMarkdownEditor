// Entirely authored fixture inputs; proposed CC0-1.0 awaits the owner.
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { documentBuilder, emit, parseArgs, seededRandom } from './authored-paper-15.mjs';

export function denseViewer(pages, seed) {
    if (![1, 40].includes(pages)) throw new Error('--pages must be 1 or 40');
    const id = pages === 40 ? 'GEN-D1-dense40' : 'GEN-D1-one-page';
    const doc = documentBuilder(`Dense viewer ${pages}`, { id, version: 1, seed });
    const rng = seededRandom(seed);
    for (let n = 1; n <= pages; n++) {
        const lines = [{ text: `DENSE VIEWER PAGE ${String(n).padStart(2, '0')}`, x: 36, y: 48, size: 16, face: 'F2' }];
        for (let row = 0; row < 60; row++) {
            lines.push({ text: `Page ${String(n).padStart(2, '0')} row ${String(row + 1).padStart(2, '0')}: a clear surface keeps ${String(Math.floor(rng() * 1_000_000)).padStart(6, '0')} marks readable.`, x: 36, y: 78 + row * 11, size: 8.5 });
        }
        lines.push({ text: `The final line of physical page ${n}.`, x: 36, y: 760, size: 9 });
        doc.page({ lines });
    }
    return { result: doc.finish(), id, expected: { description: 'Authored dense selectable text, unique page/row markers; one-page control for held renders, forty-page scroll role.',
        inkRegions: [{ page: 1, box: [36, 32, 576, 60], minimumDarkFraction: 0.01 }],
        queries: [{ query: `DENSE VIEWER PAGE ${String(pages).padStart(2, '0')}`, pages: [pages], count: 1 }],
        correctSelectAll: { scope: 'PDF bodies only', source: 'Authored pageModels lines in physical-page order' } } };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const { out, seed, pages } = parseArgs(process.argv.slice(2), ['--pages']);
    const count = Number(pages);
    const { result, id, expected } = denseViewer(count, seed);
    await emit(out, count === 40 ? 'dense-40' : 'dense-one-page', id, result, expected, seed);
}
