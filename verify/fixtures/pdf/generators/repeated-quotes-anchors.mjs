// Entirely authored; proposed licence CC0-1.0 awaits the owner's approval.
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { documentBuilder, emit, parseArgs } from './authored-paper-15.mjs';

export function anchors(seed) {
    const doc = documentBuilder('Repeated quotes and anchor contexts', { id: 'GEN-21', version: 1, seed });
    const quote = 'A measured claim needs a visible witness.';
    const lines = [
        { text: 'Repeated quote anchors', x: 42, y: 56, size: 16, face: 'F2' },
        { text: 'Cedar context before the first quote.', x: 42, y: 110, size: 10 },
        { text: quote, x: 42, y: 130, size: 10 },
        { text: 'Cedar context after the first quote.', x: 42, y: 150, size: 10 },
        { text: 'Maple context before the second quote.', x: 42, y: 350, size: 10 },
        { text: quote, x: 42, y: 370, size: 10 },
        { text: 'Maple context after the second quote.', x: 42, y: 390, size: 10 },
        { text: 'English-', x: 42, y: 500, size: 10 },
        { text: 'to is joined only by a logical projection.', x: 42, y: 516, size: 10 },
        { text: 'Boundary ends with cedar.', x: 42, y: 752, size: 10 },
    ];
    doc.page({ lines });
    doc.page({ lines: [
        { text: 'Repeated quote anchors - revised', x: 42, y: 56, size: 16, face: 'F2' },
        { text: 'A revised context is far from the old location.', x: 42, y: 590, size: 10 },
        { text: 'A measured statement needs a visible witness.', x: 42, y: 610, size: 10 },
        { text: 'Tie control: identical quotes need context.', x: 42, y: 650, size: 10 },
    ] });
    return { result: doc.finish(), expected: { description: 'Two identical quotes with distinct contexts, line-end English-/to, an empty-anchor case and distant revised quote.',
        queries: [{ query: quote, pages: [1, 1], count: 2 }, { query: 'English-to', pages: [1], count: 1, construction: ['English-', 'to'] },
            { query: 'A measured statement', pages: [2], count: 1 }],
        gestures: { title: { page: 1, from: [42, 52], to: [42 + 'Repeated quote anchors'.length * 9.6, 52], correct: 'Repeated quote anchors' },
            twoLine: { page: 1, from: [42, 106], to: [42 + quote.length * 6, 126], correct: 'Cedar context before the first quote.\n' + quote },
            crossPage: { from: { page: 1, point: [42, 748] }, to: { page: 2, point: [42 + 'Repeated quote anchors - revised'.length * 9.6, 52] }, correct: 'Boundary ends with cedar.\nRepeated quote anchors - revised' } },
        anchorCases: [{ page: 1, quote, before: 'Cedar context before the first quote.', after: 'Cedar context after the first quote.', point: [42, 130] },
            { page: 1, quote, before: 'Maple context before the second quote.', after: 'Maple context after the second quote.', point: [42, 370] },
            { page: 1, quote: '', before: '', after: '', point: [42, 250] }],
        schema2Variants: [{ extractionSchema: 2, quote, before: 'Maple context before the second quote.', after: 'Maple context after the second quote.' },
            { extractionSchema: 2, quote: 'English-to', before: '', after: ' is joined only by a logical projection.' }],
        correctSelectAll: { scope: 'Only the two PDF page bodies', source: 'pageModels.lines[].text in authored content order' } } };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const { out, seed } = parseArgs(process.argv.slice(2));
    const { result, expected } = anchors(seed);
    await emit(out, 'repeated-quotes-anchors', 'GEN-21', result, expected, seed);
}
