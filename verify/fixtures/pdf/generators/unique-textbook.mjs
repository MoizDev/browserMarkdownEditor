// SPDX-License-Identifier: CC0-1.0
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { documentBuilder, emit, parseArgs, seededRandom } from './authored-paper-15.mjs';

export function textbook(pages, seed) {
    if (![876, 1000].includes(pages)) throw new Error('The admitted variants have exactly 876 or 1000 pages.');
    const rng = seededRandom(seed), doc = documentBuilder(`Unique textbook ${pages}`, { id: `GEN-18-${pages}`, version: 1, seed });
    const sentinelPages = [3, 450, 700, pages];
    const quote = 'A quiet bridge joins the two banks.';
    for (let n = 1; n <= pages; n++) {
        const code = String(n).padStart(4, '0'), chapter = Math.floor((n - 1) / 24) + 1;
        const lines = [{ text: `Chapter ${String(chapter).padStart(2, '0')} - Authored systems`, x: 42, y: 48, size: 15, face: 'F2' },
            { text: `TEXTBOOK-PAGE-${code}`, x: 42, y: 76, size: 12, face: 'F2' }];
        if (sentinelPages.includes(n)) lines.push({ text: `NEVER-BUILT-TARGET-${code}`, x: 42, y: 108, size: 11 });
        const columns = n % 3 === 0 ? 2 : 1;
        for (let column = 0; column < columns; column++) {
            for (let row = 0; row < 29; row++) {
                const number = Math.floor(rng() * 1_000_000).toString().padStart(6, '0');
                lines.push({ text: columns === 2 ? `P${code} C${column + 1} L${String(row + 1).padStart(2, '0')} value ${number}` : `Page ${code}, line ${String(row + 1).padStart(2, '0')}: sample ${number} has a bounded witness.`,
                    x: 42 + column * 274, y: 146 + row * 15, size: 9 });
            }
        }
        lines.push({ text: 'The midpoint anchor is independent.', x: 42, y: 605, size: 10 });
        if (sentinelPages.includes(n)) {
            lines.push({ text: quote, x: 42, y: 626, size: 10 },
                { text: 'A bridge supports inter-', x: 42, y: 645, size: 10 },
                { text: 'operability between two readers.', x: 42, y: 660, size: 10 });
        } else lines.push({ text: 'Math: f(x) = x*x + 2*x + 1', x: 42, y: 646, size: 10, face: 'F3' });
        lines.push({ text: `Textbook footer ${code}.`, x: 42, y: 752, size: 10 });
        doc.page({ lines, image: n % 11 === 0, uniqueResources: n % 17 === 0,
            art: n % 7 === 0 ? 'q /GS1 gs 0.1 0.6 0.3 rg 330 90 150 40 re f Q\nq 0.2 0.3 0.8 RG 1 w 320 100 m 380 155 l 460 110 l S Q' : '' });
    }
    return { result: doc.finish(), expected: { description: 'Unique authored full-scale book. Seeded unique numeric lines; single/two columns, repeated/distinct image and font resources, math and transparent vector figures.',
        queries: [...sentinelPages.map(page => ({ query: `NEVER-BUILT-TARGET-${String(page).padStart(4, '0')}`, pages: [page], count: 1, neverBuiltOnOpen: true })),
            { query: quote, pages: sentinelPages, count: sentinelPages.length },
            { query: 'interoperability', pages: sentinelPages, count: sentinelPages.length, construction: ['inter-', 'operability'] }],
        gestures: { title: { page: 1, from: [42, 44], to: [42 + 'Chapter 01 - Authored systems'.length * 9, 44], correct: 'Chapter 01 - Authored systems' },
            twoLine: { page: 1, from: [42, 142], to: [42 + 64 * 5.4, 157], correctFromSource: 'pageModels[0].lines at y=146 and y=161' },
            crossPage: { from: { page: 1, point: [42, 748] }, to: { page: 2, point: [42 + 'Chapter 01 - Authored systems'.length * 9, 44] }, correct: 'Textbook footer 0001.\nChapter 01 - Authored systems' } },
        anchor: { page: 450, quote: 'The midpoint anchor is independent.', point: [42, 605] },
        correctSelectAll: { scope: 'All physical pages, only PDF content', source: 'pageModels.lines[].text in authored content order' } } };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const options = parseArgs(process.argv.slice(2), ['--pages']);
    const pages = Number(options.pages);
    const { result, expected } = textbook(pages, options.seed);
    await emit(options.out, `unique-textbook-${pages}`, `GEN-18-${pages}`, result, expected, options.seed);
}
