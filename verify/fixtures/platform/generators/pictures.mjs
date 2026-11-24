import { rgb, StandardFonts } from 'pdf-lib';
import { parseArgs } from '../../lib/cli.mjs';
import { fixtureWriter, jsonBytes } from '../../lib/output.mjs';
import { createDeterministicPdf, saveDeterministicPdf } from '../../lib/pdf.mjs';
const { out, seed } = parseArgs(process.argv.slice(2));
const identity = { id: 'PLATFORM-PICTURES', version: 1, seed };
const document = await createDeterministicPdf(identity);
const font = await document.embedFont(StandardFonts.Helvetica);
const checker = document.addPage([320, 320]);
checker.drawText('BME-CHECKER-v1', { x: 20, y: 294, size: 12, font });
for (let y = 0; y < 16; y++)
    for (let x = 0; x < 16; x++) {
        checker.drawRectangle({ x: 32 + x * 16, y: 16 + y * 16, width: 16, height: 16, color: rgb(...((x + y) % 2 ? [0, 0, 0] : [1, 1, 1])) });
    }
const overlap = document.addPage([320, 320]);
overlap.drawText('BME-OVERLAP-v1', { x: 20, y: 294, size: 12, font });
overlap.drawRectangle({ x: 48, y: 48, width: 160, height: 160, color: rgb(1, 0, 0), opacity: 0.5 });
overlap.drawRectangle({ x: 112, y: 112, width: 160, height: 160, color: rgb(0, 0, 1), opacity: 0.5 });
const hairline = document.addPage([320, 320]);
hairline.drawText('BME-HAIRLINES-v1', { x: 20, y: 294, size: 12, font });
const widths = [0, 0.1, 0.25, 0.5, 1];
for (let i = 0; i < widths.length; i++) {
    hairline.drawLine({ start: { x: 24.25, y: 48.25 + 40 * i }, end: { x: 288.75, y: 48.25 + 40 * i }, thickness: widths[i], color: rgb(0, 0, 0) });
    hairline.drawLine({ start: { x: 32.125 + 48 * i, y: 24.125 }, end: { x: 32.125 + 48 * i, y: 256.875 }, thickness: widths[i], color: rgb(0, 0, 0) });
}
const write = fixtureWriter(out);
await write('picture-pages.pdf', await saveDeterministicPdf(document, identity));
await write('picture-pages.oracle.json', jsonBytes({ schema: 1, seed, pages: [
        { page: 1, name: 'checker', size: [320, 320], grid: { origin: [32, 16], cell: 16, columns: 16, rows: 16 } },
        { page: 2, name: 'overlap', colorsOnWhite: { redOnly: [1, 0.5, 0.5], blueOnly: [0.5, 0.5, 1], overlap: [0.5, 0.25, 0.75] } },
        { page: 3, name: 'hairlines', widths, originFraction: 0.25 },
    ] }));
