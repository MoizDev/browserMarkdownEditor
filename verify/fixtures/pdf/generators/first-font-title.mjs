// Authored first-font control; proposed CC0-1.0 awaits the owner.
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pdfBuilder, parseArgs, fixtureWriter, jsonBytes } from './rtl-cjk-unicode.mjs';

export async function generateFirstFont(out, seed) {
    const title = 'First font cache collision';
    const doc = pdfBuilder({ id: 'GEN-P11b-first-font-30', version: 1, seed });
    doc.page({ lines: [
        { text: title, x: 42, y: 80, size: 30 },
        { text: 'Only the completed text layer is remeasured.', x: 42, y: 140, size: 11 },
    ] });
    const result = doc.finish();
    const output = fixtureWriter(out);
    const record = await output('first-font-title.pdf', result.bytes);
    await output('first-font-title.expected.json', jsonBytes({ ...record, id: 'GEN-P11b-first-font-30', pages: 1, seed, generatorVersion: 1,
        licence: 'NOASSERTION', proposedLicence: 'CC0-1.0', writerVersion: 'BME raw PDF serializer v2',
        expected: { pageModels: result.pageModels, title: { page: 1, text: title, from: [42, 70], to: [42 + title.length * 18, 70], x: 42, baseline: 80, fontSize: 30, width: title.length * 18, advance: 18 },
            construction: 'First-ever text in a fresh app is 30pt Courier. At DPR1 the ascent/reset font cache collides at 30px; same glyph geometry and logical string at DPR2 is a control.' } }));
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const { out, seed } = parseArgs(process.argv.slice(2));
    await generateFirstFont(out, seed);
}
