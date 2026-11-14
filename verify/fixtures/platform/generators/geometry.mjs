import { degrees, PDFArray, PDFName, StandardFonts, rgb } from 'pdf-lib';
import { parseArgs } from '../../lib/cli.mjs';
import { fixtureWriter, jsonBytes } from '../../lib/output.mjs';
import { createDeterministicPdf, saveDeterministicPdf } from '../../lib/pdf.mjs';
const { out, seed } = parseArgs(process.argv.slice(2));
const identity = { id: 'GEN-01', version: 1, seed };
const document = await createDeterministicPdf(identity);
const font = await document.embedFont(StandardFonts.Helvetica);
const variants = [
    { name: 'control', media: [0, 0, 300, 420] },
    { name: 'crop', media: [0, 0, 360, 440], crop: [23, 31, 337, 409] },
    { name: 'nonzero-negative-origin', media: [-80, 45, 340, 465] },
    { name: 'userunit-2', media: [0, 0, 300, 420], unit: 2 },
    { name: 'inherited-boxes', media: [10, -30, 370, 410], crop: [29, -7, 347, 387], inherited: true },
    { name: 'mixed', media: [-120, -60, 320, 500], crop: [-91, -13, 281, 459], unit: 1.25 },
];
const colors = [[0.85, 0.1, 0.1], [0.1, 0.65, 0.2], [0.1, 0.25, 0.9], [0.75, 0.1, 0.7]];
const pages = [];
const inherited = [];
for (const variant of variants) {
    for (const rotation of [0, 90, 180, 270]) {
        const page = document.addPage();
        const [mx0, my0, mx1, my1] = variant.media;
        const box = variant.crop ?? variant.media;
        const [x0, y0, x1, y1] = box;
        const unit = variant.unit ?? 1;
        page.setMediaBox(mx0, my0, mx1 - mx0, my1 - my0);
        page.setCropBox(x0, y0, x1 - x0, y1 - y0);
        page.setRotation(degrees(rotation));
        page.node.set(PDFName.of('UserUnit'), document.context.obj(unit));
        const matrix = {
            0: [unit, 0, 0, -unit, -x0 * unit, y1 * unit],
            90: [0, unit, unit, 0, -y0 * unit, -x0 * unit],
            180: [-unit, 0, 0, unit, x1 * unit, -y0 * unit],
            270: [0, -unit, -unit, 0, y1 * unit, x1 * unit],
        }[rotation];
        const toDisplay = ([x, y]) => [matrix[0] * x + matrix[2] * y + matrix[4], matrix[1] * x + matrix[3] * y + matrix[5]];
        const pageId = `GEN-01-p${String(pages.length + 1).padStart(2, '0')}-${variant.name}-r${rotation}`;
        const corners = [[x0 + 16, y0 + 16], [x1 - 16, y0 + 16], [x1 - 16, y1 - 16], [x0 + 16, y1 - 16]];
        const fiducials = corners.map((point, index) => {
            const [x, y] = point;
            const color = colors[index];
            page.drawRectangle({ x: x - 5, y: y - 5, width: 10, height: 10, color: rgb(...color) });
            page.drawLine({ start: { x: x - 9, y }, end: { x: x + 9, y }, thickness: 0.5, color: rgb(0, 0, 0) });
            page.drawLine({ start: { x, y: y - 9 }, end: { x, y: y + 9 }, thickness: 0.5, color: rgb(0, 0, 0) });
            return { name: ['bottom-left', 'bottom-right', 'top-right', 'top-left'][index], pdf: point, display: toDisplay(point), color };
        });
        page.drawText(pageId, { x: x0 + 30, y: y1 - 42, size: 8, font });
        page.drawText(`BME-GEOMETRY seed ${seed}`, { x: x0 + 30, y: y1 - 58, size: 10, font });
        const linkRect = [x0 + 30, y1 - 86, x0 + 150, y1 - 70];
        const quad = [linkRect[0], linkRect[3], linkRect[2], linkRect[3], linkRect[0], linkRect[1], linkRect[2], linkRect[1]];
        page.drawText('Authored geometry link', { x: linkRect[0], y: linkRect[1] + 3, size: 9, font, color: rgb(0.1, 0.25, 0.8) });
        const annotation = document.context.register(document.context.obj({
            Type: 'Annot', Subtype: 'Link', Rect: linkRect, QuadPoints: quad, Border: [0, 0, 1],
            Dest: [page.ref, 'XYZ', x0, y1, null],
        }));
        page.node.set(PDFName.of('Annots'), document.context.obj([annotation]));
        pages.push({
            page: pages.length + 1, pageId, variant: variant.name, rotation, mediaBox: variant.media,
            cropBox: box, userUnit: unit, inherited: !!variant.inherited, pdfToDisplay: matrix,
            displaySize: rotation % 180 ? [(y1 - y0) * unit, (x1 - x0) * unit] : [(x1 - x0) * unit, (y1 - y0) * unit],
            fiducials, link: { rect: linkRect, quad, displayQuad: [0, 2, 4, 6].map(i => toDisplay([quad[i], quad[i + 1]])) },
        });
        if (variant.inherited)
            inherited.push({ page, box, media: variant.media, rotation });
    }
}
// Put inherited attributes on a one-child Pages node after all pages have been inserted: the
// library's append operation otherwise rewrites the parent while balancing its own page tree.
const root = document.catalog.Pages();
const kids = root.lookup(PDFName.of('Kids'), PDFArray);
for (const { page, box, media, rotation } of inherited) {
    const branch = document.context.register(document.context.obj({
        Type: 'Pages', Parent: document.catalog.get(PDFName.of('Pages')), Kids: [page.ref], Count: 1,
        MediaBox: media, CropBox: box, Rotate: rotation,
    }));
    for (let i = 0; i < kids.size(); i++)
        if (kids.get(i) === page.ref)
            kids.set(i, branch);
    page.node.set(PDFName.of('Parent'), branch);
    for (const name of ['MediaBox', 'CropBox', 'Rotate'])
        page.node.delete(PDFName.of(name));
}
const write = fixtureWriter(out);
await write('geometry.pdf', await saveDeterministicPdf(document, identity));
await write('geometry.oracle.json', jsonBytes({
    schema: 1, id: identity.id, seed, coordinates: 'PDF default user space to page-local top-left points including UserUnit; clockwise rotation', pages,
}));
for (const [name, box] of [['zero-width', '[0 0 0 400]'], ['non-finite', '[0 0 NaN 400]']]) {
    // Intentionally malformed tokens are separate refusal inputs, never members of the valid corpus.
    const bytes = Buffer.from(`%PDF-1.7\n1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj\n3 0 obj << /Type /Page /Parent 2 0 R /MediaBox ${box} >> endobj\ntrailer << /Root 1 0 R >>\n%%EOF\n`, 'ascii');
    await write(`geometry-invalid-${name}.pdf`, bytes);
}
