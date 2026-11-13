// SPDX-License-Identifier: CC0-1.0
// Entirely authored fixture content. No external document, font program or app code.
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';

export const SEED = 0x50444631;
export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
export const literal = text => `(${text.replaceAll('\\', '\\\\').replaceAll('(', '\\(').replaceAll(')', '\\)')})`;
// Temporary common helpers until verify/fixtures/lib lands; other generators
// import this one stand-in, and will switch to the shared names at that merge.
export function parseArgs(argv, extra = []) {
    const options = {};
    for (let i = 0; i < argv.length; i++) {
        const [key, inline] = argv[i].split('=');
        if (!['--out', '--seed', ...extra].includes(key) || options[key.slice(2)] !== undefined) throw new Error(`Unknown or repeated option: ${key}`);
        const value = inline ?? argv[++i];
        if (value === undefined || value.startsWith('--')) throw new Error(`Missing value for ${key}`);
        options[key.slice(2)] = value;
    }
    if (!options.out || !/^\d+$/u.test(options.seed ?? '') || Number(options.seed) > 0xffffffff) throw new Error('Required: --out <fresh-directory> --seed <uint32>');
    options.seed = Number(options.seed);
    return options;
}
export const jsonBytes = value => Buffer.from(JSON.stringify(value, null, 2) + '\n');
export const fixtureWriter = out => async (file, content) => {
    if (!/^[a-z0-9][a-z0-9.-]*$/u.test(file) || file.includes('..')) throw new Error('Unsafe output name');
    await mkdir(out, { recursive: true });
    await writeFile(resolve(out, file), content, { flag: 'wx' });
    const entry = { file, sha256: sha256(content), bytes: Buffer.byteLength(content) };
    console.log(JSON.stringify(entry));
    return entry;
};
export function seededRandom(seed = SEED) {
    let state = seed >>> 0;
    return () => { state ^= state << 13; state ^= state >>> 17; state ^= state << 5; return (state >>> 0) / 2 ** 32; };
}

// A deliberately small serializer, not a PDF reader. Input coordinates use a
// top-left, point-sized page so the browser gestures can use the same landmarks.
export function documentBuilder(title, identity) {
    const objects = [null, null];
    const add = value => { objects.push(Buffer.isBuffer(value) ? value : Buffer.from(value, 'ascii')); return objects.length; };
    const stream = (value, dictionary = '') => {
        const data = deflateSync(Buffer.from(value), { level: 9 });
        return add(Buffer.concat([Buffer.from(`<< /Length ${data.length} /Filter /FlateDecode ${dictionary} >>\nstream\n`), data, Buffer.from('\nendstream')]));
    };
    const font = add('<< /Type /Font /Subtype /Type1 /BaseFont /Courier /Encoding /WinAnsiEncoding >>');
    const bold = add('<< /Type /Font /Subtype /Type1 /BaseFont /Courier-Bold /Encoding /WinAnsiEncoding >>');
    const italic = add('<< /Type /Font /Subtype /Type1 /BaseFont /Courier-Oblique /Encoding /WinAnsiEncoding >>');
    const opacity = add('<< /Type /ExtGState /ca 0.35 /CA 0.35 >>');
    const pixels = Buffer.from([15, 100, 190, 240, 200, 35, 225, 65, 50, 30, 155, 105]);
    const sharedImage = stream(pixels, '/Type /XObject /Subtype /Image /Width 2 /Height 2 /ColorSpace /DeviceRGB /BitsPerComponent 8');
    const pageIds = [], expectedPages = [];
    function page({ lines, art = '', links = [], image = false, uniqueResources = false, width = 612, height = 792 }) {
        const pageFont = uniqueResources ? add('<< /Type /Font /Subtype /Type1 /BaseFont /Courier /Encoding /WinAnsiEncoding >>') : font;
        const pageImage = uniqueResources ? stream(pixels, '/Type /XObject /Subtype /Image /Width 2 /Height 2 /ColorSpace /DeviceRGB /BitsPerComponent 8') : sharedImage;
        const operations = lines.map(line => {
            const { text, x = 42, y, size = 10, face = 'F1', matrix, prefix = '', suffix = '' } = line;
            const tm = matrix ?? [1, 0, 0, 1, x, height - y];
            return `${prefix} BT /${face} ${size} Tf ${tm.join(' ')} Tm ${literal(text)} Tj ET ${suffix}`;
        });
        operations.push(art);
        if (image) operations.push(`q 64 0 0 40 456 ${height - 690} cm /Im1 Do Q`);
        const contents = stream(operations.join('\n'));
        const annots = links.map(({ box, url }) => add(`<< /Type /Annot /Subtype /Link /Rect [${box[0]} ${height - box[3]} ${box[2]} ${height - box[1]}] /Border [0 0 0] /A << /S /URI /URI ${literal(url)} >> >>`));
        const id = add(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${width} ${height}] /Resources << /Font << /F1 ${pageFont} 0 R /F2 ${bold} 0 R /F3 ${italic} 0 R >> /ExtGState << /GS1 ${opacity} 0 R >> /XObject << /Im1 ${pageImage} 0 R >> >> /Contents ${contents} 0 R ${annots.length ? `/Annots [${annots.map(n => `${n} 0 R`).join(' ')}]` : ''} >>`);
        pageIds.push(id);
        expectedPages.push({ page: pageIds.length, geometry: { viewBox: [0, 0, width, height], rotation: 0, userUnit: 1, width, height }, lines });
    }
    function finish() {
        objects[0] = Buffer.from('<< /Type /Catalog /Pages 2 0 R >>');
        objects[1] = Buffer.from(`<< /Type /Pages /Count ${pageIds.length} /Kids [${pageIds.map(id => `${id} 0 R`).join(' ')}] >>`);
        const info = add(`<< /Title ${literal(title)} /Author (Authored CC0 fixture) /Creator (deterministic authored fixture v1) /Producer (independent raw PDF serializer v1) /CreationDate (D:20000101000000Z) /ModDate (D:20000101000000Z) >>`);
        const chunks = [Buffer.from('%PDF-1.7\n%\xe2\xe3\xcf\xd3\n', 'latin1')], offsets = [0];
        let length = chunks[0].length;
        for (const [index, object] of objects.entries()) {
            offsets.push(length);
            const chunk = Buffer.concat([Buffer.from(`${index + 1} 0 obj\n`), object, Buffer.from('\nendobj\n')]);
            chunks.push(chunk); length += chunk.length;
        }
        const id = sha256(JSON.stringify([identity.id, identity.version, identity.seed]));
        const xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R /Info ${info} 0 R /ID [<${id}><${id}>] >>\nstartxref\n${length}\n%%EOF\n`;
        chunks.push(Buffer.from(xref));
        return { bytes: Buffer.concat(chunks), expectedPages };
    }
    return { page, finish };
}

export async function emit(outDir, name, id, result, expected, seed) {
    const file = `${name}.pdf`, bytes = result.bytes;
    const record = { id, file, sha256: sha256(bytes), bytes: bytes.length, pages: result.expectedPages.length, seed,
        licence: 'CC0-1.0', generatorVersion: 1, writerVersion: 'independent raw PDF serializer v1',
        expected: { ...expected, correctSelectAllText: result.expectedPages.map(page => page.lines.map(line => line.text).join('\n')).join('\n\n'), pageModels: result.expectedPages } };
    const output = fixtureWriter(outDir);
    await output(file, bytes);
    await output(`${name}.expected.json`, jsonBytes(record));
    return record;
}

export function paper(seed) {
    const doc = documentBuilder('Small Systems, Clear Evidence', { id: 'GEN-23', version: 1, seed });
    const title = 'Small Systems, Clear Evidence';
    const abstract = ['A small window keeps the reading surface calm.', 'Every visible mark has an independent witness.'];
    const quote = 'A measured claim needs a visible witness.';
    for (let n = 1; n <= 15; n++) {
        const lines = [{ text: n === 1 ? title : `Authored paper section ${String(n).padStart(2, '0')}`, x: 42, y: 56, size: n === 1 ? 18 : 15, face: 'F2' }];
        if (n === 1) {
            lines.push({ text: 'Abstract', x: 42, y: 100, face: 'F2', size: 12 });
            abstract.forEach((text, i) => lines.push({ text, x: 42, y: 124 + 16 * i, size: 11 }));
        }
        for (let column = 0; column < 2; column++) {
            for (let row = 0; row < 27; row++) {
                const text = row === 3 ? `PAPER-${String(n).padStart(2, '0')}-COL-${column + 1}`
                    : row === 8 ? (column === 0 ? 'A calm interface keeps inter-' : 'Each result names its source.')
                    : row === 9 && column === 0 ? 'operability visible to readers.'
                    : `Page ${String(n).padStart(2, '0')} ${column ? 'right' : 'left '} line ${String(row + 1).padStart(2, '0')}: clear evidence.`;
                lines.push({ text, x: 42 + column * 274, y: 192 + row * 15, size: 9 });
            }
        }
        lines.push({ text: quote, x: 42, y: 625, size: 10 });
        lines.push({ text: 'split', x: 42, y: 648, size: 10 }, { text: 'font', x: 72, y: 648, size: 10, face: 'F2' });
        lines.push({ text: 'x = a + b; area = w * h', x: 42, y: 676, size: 10, face: 'F3' });
        if (n === 3) {
            lines.push({ text: 'ROTATED AXIS', size: 8, matrix: [0, 1, -1, 0, 568, 150] });
            lines.push({ text: 'DIAGONAL', size: 8, matrix: [0.866, 0.5, -0.5, 0.866, 380, 110] });
            lines.push({ text: 'INVISIBLE-PAPER', x: 42, y: 705, prefix: 'q', suffix: 'Q', size: 9 });
            lines.at(-1).prefix = 'q 0 0 0 0 re W n';
            lines.push({ text: 'TRANSPARENT-PAPER', x: 300, y: 705, prefix: 'q /GS1 gs', suffix: 'Q', size: 9 });
        }
        lines.push({ text: n === 1 ? 'Boundary ends with cedar.' : `Paper footer ${String(n).padStart(2, '0')}.`, x: 42, y: 752, size: 10 });
        doc.page({ lines, image: true, art: 'q /GS1 gs 0.1 0.5 0.8 rg 220 90 76 35 re f Q\nq 0.2 0.4 0.8 RG 1.5 w 330 110 m 400 140 l 480 100 l S Q',
            links: [{ box: [42, 612, 282, 628], url: 'https://example.invalid/authored-evidence' }] });
    }
    return { result: doc.finish(), expected: { description: 'Authored two-column paper; title/abstract/boundary copy, repeated quote, ASCII hyphen and split-font word, rotated/hidden/translucent text, vector/image and inert external link.',
        gestures: { title: { page: 1, from: [42, 49], to: [42 + title.length * 10.8, 49], correct: title },
            twoLine: { page: 1, from: [42, 120], to: [42 + abstract[1].length * 6.6, 136], correct: abstract.join('\n') },
            crossPage: { from: { page: 1, point: [42, 748] }, to: { page: 2, point: [42 + 'Authored paper section 02'.length * 9, 52] }, correct: 'Boundary ends with cedar.\nAuthored paper section 02' } },
        queries: [{ query: 'PAPER-01-COL-1', pages: [1], count: 1 }, { query: 'PAPER-15-COL-2', pages: [15], count: 1 },
            { query: quote, pages: Array.from({ length: 15 }, (_, i) => i + 1), count: 15 },
            { query: 'interoperability', pages: Array.from({ length: 15 }, (_, i) => i + 1), count: 15, construction: ['inter-', 'operability'] },
            { query: 'splitfont', pages: Array.from({ length: 15 }, (_, i) => i + 1), count: 15, construction: ['split (Courier)', 'font (Courier-Bold)'] }],
        correctSelectAll: { scope: 'PDF page text only, in physical-page/content order; no file tree, controls or notices', source: 'pageModels.lines[].text; preserve drawn words, join line breaks, splitfont is one word' } } };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const { out, seed } = parseArgs(process.argv.slice(2));
    const { result, expected } = paper(seed);
    await emit(out, 'authored-paper-15', 'GEN-23', result, expected, seed);
}
