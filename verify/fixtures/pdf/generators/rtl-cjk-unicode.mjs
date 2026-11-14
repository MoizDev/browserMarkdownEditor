// Entirely authored diagnostic outlines and text; proposed CC0-1.0 awaits the owner.
// No font program, artwork, app module or system font is read by this generator.
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';
import { parseArgs } from '../../lib/cli.mjs';
import { fixtureWriter, jsonBytes, sha256 } from '../../lib/output.mjs';

export const literal = text => `(${text.replaceAll('\\', '\\\\').replaceAll('(', '\\(').replaceAll(')', '\\)')})`;
export const utf16 = text => {
    const bytes = Buffer.from(text, 'utf16le');
    bytes.swap16();
    return bytes.toString('hex');
};
export const unicodeString = text => `<feff${utf16(text)}>`;

/** A fixed authored object graph serializer, not a PDF parser or a rasterizer. */
export function pdfBuilder(identity) {
    const objects = [null, null];
    const reserve = () => { objects.push(null); return objects.length; };
    const set = (id, value) => { objects[id - 1] = Buffer.isBuffer(value) ? value : Buffer.from(value, 'ascii'); };
    const add = value => { const id = reserve(); set(id, value); return id; };
    const stream = (value, dictionary = '') => {
        const bytes = deflateSync(Buffer.from(value), { level: 9 });
        return add(Buffer.concat([Buffer.from(`<< /Length ${bytes.length} /Filter /FlateDecode ${dictionary} >>\nstream\n`), bytes, Buffer.from('\nendstream')]));
    };
    const courier = add('<< /Type /Font /Subtype /Type1 /BaseFont /Courier /Encoding /WinAnsiEncoding >>');
    const pageIds = [];
    const pageModels = [];
    const page = ({ lines, operations = [], resources = '', otherResources = '', annotations = [], extra = '' }) => {
        const id = reserve();
        const contents = stream([
            ...lines.map(({ text, x = 42, y, size = 11, prefix = '', suffix = '', custom, operator = '' }) => custom ? operator : `${prefix} BT /F0 ${size} Tf 1 0 0 1 ${x} ${792 - y} Tm ${literal(text)} Tj ET ${suffix}`),
            ...operations,
        ].join('\n'));
        const annots = annotations.map(annotation => add(annotation));
        set(id, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F0 ${courier} 0 R ${resources} >> ${otherResources} >> /Contents ${contents} 0 R ${annots.length ? `/Annots [${annots.map(n => `${n} 0 R`).join(' ')}]` : ''} ${extra} >>`);
        pageIds.push(id);
        pageModels.push({ page: pageIds.length, geometry: { viewBox: [0, 0, 612, 792], rotation: 0, userUnit: 1, width: 612, height: 792 }, lines: lines.map(line => { const model = { ...line }; delete model.operator; return model; }) });
        return id;
    };
    const finish = (catalogueExtra = '') => {
        set(1, `<< /Type /Catalog /Pages 2 0 R ${catalogueExtra} >>`);
        set(2, `<< /Type /Pages /Count ${pageIds.length} /Kids [${pageIds.map(n => `${n} 0 R`).join(' ')}] >>`);
        const info = add('<< /Author (Authored synthetic fixture) /Creator (BME authored glyph fixture v1) /Producer (BME raw PDF serializer v2) /CreationDate (D:20000101000000Z) /ModDate (D:20000101000000Z) >>');
        const chunks = [Buffer.from('%PDF-1.7\n%\xe2\xe3\xcf\xd3\n', 'latin1')];
        const offsets = [];
        let length = chunks[0].length;
        objects.forEach((object, index) => {
            if (!object) throw new Error(`Unfilled PDF object ${index + 1}`);
            offsets.push(length);
            const chunk = Buffer.concat([Buffer.from(`${index + 1} 0 obj\n`), object, Buffer.from('\nendobj\n')]);
            chunks.push(chunk);
            length += chunk.length;
        });
        const id = sha256(JSON.stringify([identity.id, identity.version, identity.seed]));
        chunks.push(Buffer.from(`xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R /Info ${info} 0 R /ID [<${id}><${id}>] >>\nstartxref\n${length}\n%%EOF\n`));
        return { bytes: Buffer.concat(chunks), pageModels };
    };
    return { reserve, set, add, stream, page, pageIds, courier, finish };
}

export function toUnicode(glyphs, wide = true, firstCode = 1) {
    const code = n => n.toString(16).padStart(wide ? 4 : 2, '0');
    return `/CIDInit /ProcSet findresource begin\n12 dict begin\nbegincmap\n/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def\n/CMapName /AuthoredUnicode def\n/CMapType 2 def\n1 begincodespacerange\n<${wide ? '0000' : '00'}> <${wide ? 'ffff' : 'ff'}>\nendcodespacerange\n${glyphs.length} beginbfchar\n${glyphs.map((glyph, i) => `<${code(i + firstCode)}> <${utf16(glyph.unicode)}>`).join('\n')}\nendbfchar\nendcmap\nCMapName currentdict /CMap defineresource pop\nend\nend`;
}

export const rectangle = (x, y, width, height) => [[x, y], [x + width, y], [x + width, y + height], [x, y + height]];
export function stroke(points, width = 55) {
    return points.slice(1).map((b, i) => {
        const a = points[i], length = Math.hypot(b[0] - a[0], b[1] - a[1]);
        const dx = (b[1] - a[1]) * width / (2 * length), dy = (a[0] - b[0]) * width / (2 * length);
        return [[a[0] + dx, a[1] + dy], [b[0] + dx, b[1] + dy], [b[0] - dx, b[1] - dy], [a[0] - dx, a[1] - dy]].map(p => p.map(Math.round));
    });
}
const strokes = (...paths) => paths.flatMap(path => stroke(path));
const ring = (cx, cy, r) => {
    const vertices = Array.from({ length: 16 }, (_, i) => [Math.round(cx + r * Math.cos(i * Math.PI / 8)), Math.round(cy + r * Math.sin(i * Math.PI / 8))]);
    return stroke([...vertices, vertices[0]], 35);
};

// These are deliberately small diagnostic letterforms, not a typography golden.
// Arabic entries have distinct initial/medial/final outlines, selected explicitly;
// the PDF does not ask a platform shaper or system font to invent contextual forms.
export const glyphs = [
    { key: 'behFinal', unicode: 'ب', contours: [...strokes([[700, 300], [570, 300], [530, 120], [120, 120], [80, 300]]), rectangle(290, -25, 65, 65)] },
    { key: 'behMedial', unicode: 'ب', contours: [...strokes([[0, 300], [300, 300], [350, 480], [400, 300], [700, 300]]), rectangle(325, 80, 65, 65)] },
    { key: 'seenInitial', unicode: 'س', contours: strokes([[0, 300], [160, 300], [200, 470], [240, 300], [350, 300], [390, 470], [430, 300], [540, 300], [580, 470], [630, 300]]) },
    { key: 'gimel', unicode: 'ג', contours: strokes([[200, 700], [460, 700], [460, 120], [150, 0]], [[460, 200], [590, 0]]) },
    { key: 'bet', unicode: 'ב', contours: strokes([[100, 700], [580, 700], [580, 50], [80, 50]], [[80, 50], [650, 50]]) },
    { key: 'alef', unicode: 'א', contours: strokes([[120, 700], [580, 0]], [[580, 700], [430, 440]], [[270, 260], [120, 0]]) },
    { key: 'sun', unicode: '日', contours: strokes([[100, 0], [100, 760], [600, 760], [600, 0], [100, 0]], [[100, 380], [600, 380]]) },
    { key: 'root', unicode: '本', contours: strokes([[70, 560], [630, 560]], [[350, 800], [350, 0]], [[350, 560], [70, 100]], [[350, 560], [630, 100]], [[170, 220], [530, 220]]) },
    { key: 'three', unicode: '三', contours: strokes([[110, 700], [590, 700]], [[160, 400], [540, 400]], [[50, 80], [650, 80]]) },
    { key: 'moon', unicode: '月', contours: strokes([[90, 0], [170, 200], [170, 760], [590, 760], [590, 0], [480, 0]], [[170, 510], [590, 510]], [[170, 260], [590, 260]]) },
    { key: 'eAcute', unicode: 'e\u0301', contours: [...strokes([[130, 300], [570, 300], [570, 500], [450, 620], [220, 620], [100, 480], [100, 160], [230, 50], [520, 50]], [[320, 740], [480, 850]])] },
    { key: 'face', unicode: '🙂', contours: [...ring(350, 360, 320), rectangle(220, 440, 45, 55), rectangle(440, 440, 45, 55), ...strokes([[180, 260], [260, 160], [440, 160], [520, 260]])] },
    { key: 'womanLaptop', unicode: '👩‍💻', width: 1200, contours: [...ring(280, 600, 130), ...strokes([[100, 430], [80, 780], [480, 780], [500, 430]], [[280, 450], [280, 120]], [[280, 350], [540, 250]]), ...strokes([[550, 100], [550, 500], [1080, 500], [1080, 100], [550, 100]], [[480, 50], [1150, 50]])] },
    { key: 'e', unicode: 'e', contours: strokes([[130, 300], [570, 300], [570, 500], [450, 620], [220, 620], [100, 480], [100, 160], [230, 50], [520, 50]]) },
    { key: 'acute', unicode: '\u0301', width: 0, contours: strokes([[-380, 740], [-220, 850]]) },
    { key: 'o', unicode: 'o', contours: strokes([[150, 50], [70, 180], [70, 500], [150, 620], [500, 620], [580, 500], [580, 180], [500, 50], [150, 50]]) },
    { key: 'f', unicode: 'f', contours: strokes([[220, 0], [220, 700], [350, 820], [550, 820]], [[70, 500], [500, 500]]) },
    { key: 'fiSequence', unicode: 'fi', width: 1200, contours: [...strokes([[220, 0], [220, 700], [350, 820], [550, 820]], [[70, 500], [500, 500]], [[850, 500], [850, 0]]), rectangle(815, 700, 70, 70)] },
    { key: 'fiPresentation', unicode: '\ufb01', width: 1200, contours: [...strokes([[220, 0], [220, 700], [350, 820], [550, 820]], [[70, 500], [500, 500]], [[850, 500], [850, 0]]), rectangle(815, 700, 70, 70)] },
    { key: 'c', unicode: 'c', contours: strokes([[550, 540], [460, 620], [180, 620], [80, 500], [80, 170], [190, 50], [470, 50], [560, 140]]) },
].map(glyph => ({ width: 700, ...glyph }));

/** Minimal TrueType outlines, serialized from authored polygons only. All points
 *  are on-curve; no hint program, shaping tables, copied metrics or font tools. */
function trueType(glyphList) {
    const padded = data => Buffer.concat([data, Buffer.alloc((4 - data.length % 4) % 4)]);
    const sum = data => { let n = 0; const bytes = padded(data); for (let i = 0; i < bytes.length; i += 4) n = (n + bytes.readUInt32BE(i)) >>> 0; return n; };
    const entries = [{ width: 700, contours: [] }, ...glyphList];
    const metrics = Buffer.alloc(entries.length * 4);
    const locations = [0], shapes = [];
    let maxPoints = 0, maxContours = 0;
    entries.forEach((glyph, index) => {
        const points = glyph.contours.flat(), count = points.length;
        maxPoints = Math.max(maxPoints, count); maxContours = Math.max(maxContours, glyph.contours.length);
        metrics.writeUInt16BE(glyph.width, index * 4);
        if (!count) { locations.push(locations.at(-1)); return; }
        const data = Buffer.alloc(12 + glyph.contours.length * 2 + count * 5 + ((12 + glyph.contours.length * 2 + count * 5) % 2));
        data.writeInt16BE(glyph.contours.length, 0);
        [Math.min(...points.map(p => p[0])), Math.min(...points.map(p => p[1])), Math.max(...points.map(p => p[0])), Math.max(...points.map(p => p[1]))].forEach((n, i) => data.writeInt16BE(n, 2 + 2 * i));
        let endpoint = -1;
        glyph.contours.forEach((contour, i) => { endpoint += contour.length; data.writeUInt16BE(endpoint, 10 + i * 2); });
        let offset = 12 + glyph.contours.length * 2;
        for (let i = 0; i < count; i++) data[offset++] = 1;
        for (const axis of [0, 1]) {
            let previous = 0;
            for (const point of points) { data.writeInt16BE(point[axis] - previous, offset); offset += 2; previous = point[axis]; }
        }
        shapes.push(data); locations.push(locations.at(-1) + data.length);
    });
    const head = Buffer.alloc(54); head.writeUInt32BE(0x10000, 0); head.writeUInt32BE(0x10000, 4); head.writeUInt32BE(0x5f0f3cf5, 12); head.writeUInt16BE(1000, 18);
    // TrueType's epoch is 1904; fixed 2000-01-01, not a wall-clock read.
    head.writeBigUInt64BE(3029529600n, 20); head.writeBigUInt64BE(3029529600n, 28);
    [-500, -200, 1300, 900].forEach((n, i) => head.writeInt16BE(n, 36 + i * 2)); head.writeUInt16BE(8, 46); head.writeInt16BE(2, 48);
    const hhea = Buffer.alloc(36); hhea.writeUInt32BE(0x10000); hhea.writeInt16BE(900, 4); hhea.writeInt16BE(-200, 6); hhea.writeUInt16BE(1200, 10); hhea.writeInt16BE(-500, 12); hhea.writeInt16BE(-500, 14); hhea.writeInt16BE(1300, 16); hhea.writeInt16BE(1, 18); hhea.writeUInt16BE(entries.length, 34);
    const maxp = Buffer.alloc(32); maxp.writeUInt32BE(0x10000); maxp.writeUInt16BE(entries.length, 4); maxp.writeUInt16BE(maxPoints, 6); maxp.writeUInt16BE(maxContours, 8); maxp.writeUInt16BE(2, 14);
    const loca = Buffer.alloc(locations.length * 2); locations.forEach((n, i) => loca.writeUInt16BE(n / 2, i * 2));
    const post = Buffer.alloc(32); post.writeUInt32BE(0x30000);
    const cmap = Buffer.alloc(28 + glyphList.length * 12); cmap.writeUInt16BE(1, 2); cmap.writeUInt16BE(3, 4); cmap.writeUInt16BE(10, 6); cmap.writeUInt32BE(12, 8); cmap.writeUInt16BE(12, 12); cmap.writeUInt32BE(cmap.length - 12, 16); cmap.writeUInt32BE(glyphList.length, 24);
    glyphList.forEach((_, i) => { const p = 28 + i * 12; cmap.writeUInt32BE(0xe001 + i, p); cmap.writeUInt32BE(0xe001 + i, p + 4); cmap.writeUInt32BE(i + 1, p + 8); });
    const names = [[1, 'BMEAuthoredGlyphs'], [2, 'Regular'], [4, 'BME Authored Glyphs'], [6, 'BMEAuthoredGlyphs'], [13, 'Authored diagnostic outlines; licence not asserted']];
    const strings = names.map(([, name]) => Buffer.from(utf16(name), 'hex')); const name = Buffer.alloc(6 + names.length * 12); name.writeUInt16BE(names.length, 2); name.writeUInt16BE(name.length, 4);
    let start = 0;
    names.forEach(([id], i) => { const p = 6 + i * 12; [3, 1, 0x409, id, strings[i].length, start].forEach((n, j) => name.writeUInt16BE(n, p + 2 * j)); start += strings[i].length; });
    const tables = [['cmap', cmap], ['glyf', Buffer.concat(shapes)], ['head', head], ['hhea', hhea], ['hmtx', metrics], ['loca', loca], ['maxp', maxp], ['name', Buffer.concat([name, ...strings])], ['post', post]];
    const header = Buffer.alloc(12 + tables.length * 16); header.writeUInt32BE(0x10000); header.writeUInt16BE(tables.length, 4); header.writeUInt16BE(128, 6); header.writeUInt16BE(3, 8); header.writeUInt16BE(tables.length * 16 - 128, 10);
    let offset = header.length, headOffset = 0;
    tables.forEach(([tag, data], i) => { const p = 12 + i * 16; header.write(tag, p, 4, 'ascii'); header.writeUInt32BE(sum(data), p + 4); header.writeUInt32BE(offset, p + 8); header.writeUInt32BE(data.length, p + 12); if (tag === 'head') headOffset = offset; offset += padded(data).length; });
    const result = Buffer.concat([header, ...tables.map(([, data]) => padded(data))]); result.writeUInt32BE((0xb1b0afba - sum(result)) >>> 0, headOffset + 8);
    return result;
}

export function glyphPath(glyph) {
    return glyph.contours.map(contour => `${contour[0].join(' ')} m ${contour.slice(1).map(p => `${p.join(' ')} l`).join(' ')} h f`).join('\n');
}
const codeFor = key => { const i = glyphs.findIndex(g => g.key === key); if (i < 0) throw new Error(`Unknown authored glyph ${key}`); return (i + 1).toString(16).padStart(4, '0'); };
const codes = keys => `<${keys.map(codeFor).join('')}>`;
const glyphWidth = keys => keys.reduce((n, key) => n + glyphs.find(g => g.key === key).width, 0);

export async function generateUnicode(out, seed) {
    const doc = pdfBuilder({ id: 'GEN-08', version: 1, seed });
    const fontBytes = trueType(glyphs);
    const file = doc.stream(fontBytes, `/Length1 ${fontBytes.length}`);
    const cmap = doc.stream(toUnicode(glyphs));
    function cidFont(embedded, vertical = false) {
        const descriptor = doc.add(`<< /Type /FontDescriptor /FontName /BMEAuthoredGlyphs /Flags 4 /FontBBox [-500 -200 1300 900] /ItalicAngle 0 /Ascent 900 /Descent -200 /CapHeight 800 /StemV 55 ${embedded ? `/FontFile2 ${file} 0 R` : ''} >>`);
        const descendant = doc.add(`<< /Type /Font /Subtype /CIDFontType2 /BaseFont /BMEAuthoredGlyphs /CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> /FontDescriptor ${descriptor} 0 R /CIDToGIDMap /Identity /DW 700 /W [1 [${glyphs.map(g => g.width).join(' ')}]] /DW2 [880 -1000] >>`);
        return doc.add(`<< /Type /Font /Subtype /Type0 /BaseFont /BMEAuthoredGlyphs /Encoding /Identity-${vertical ? 'V' : 'H'} /DescendantFonts [${descendant} 0 R] /ToUnicode ${cmap} 0 R >>`);
    }
    const fonts = { embedded: cidFont(true), fallback: cidFont(false), vertical: cidFont(true, true), verticalFallback: cidFont(false, true) };
    const definitions = [
        { role: 'arabic-contextual', title: 'Authored Unicode glyph controls', keys: ['behFinal', 'behMedial', 'seenInitial'], text: 'سبب', visual: 'ببس', direction: 'rtl' },
        { role: 'hebrew-mixed', title: 'Unicode boundary begins with maple.', keys: ['gimel', 'bet', 'alef'], text: 'אבג', visual: 'גבא', direction: 'rtl', mixed: 'ABC 123' },
        { role: 'cjk-horizontal', title: 'Horizontal Japanese and CJK', keys: ['sun', 'root', 'three', 'moon'], text: '日本三月', direction: 'ltr' },
        { role: 'cjk-vertical', title: 'Vertical Japanese and CJK', keys: ['sun', 'root', 'three', 'moon'], text: '日本三月', direction: 'ttb', vertical: true },
        { role: 'clusters', title: 'Combining and joined emoji clusters', keys: ['eAcute', 'face', 'womanLaptop'], text: 'e\u0301🙂👩‍💻', direction: 'ltr' },
        { role: 'separate-combining', title: 'Separate zero-advance combining mark', keys: ['e', 'acute'], text: 'e\u0301', direction: 'ltr' },
        { role: 'ligature-sequence', title: 'Sequence ligature mapping', keys: ['o', 'f', 'fiSequence', 'c', 'e'], text: 'office', direction: 'ltr' },
        { role: 'ligature-presentation', title: 'Presentation ligature mapping', keys: ['o', 'f', 'fiPresentation', 'c', 'e'], text: 'of\ufb01ce', direction: 'ltr' },
    ];
    const probes = [];
    [...definitions, ...definitions.slice(0, 4).map((def, i) => ({ ...def, fallback: true, pairedPage: i + 1, title: `Nonembedded CID control ${i + 1}` }))].forEach((def, index) => {
        const page = index + 1, x = 100, y = 250, size = 48;
        const font = def.vertical ? (def.fallback ? fonts.verticalFallback : fonts.vertical) : def.fallback ? fonts.fallback : fonts.embedded;
        const lines = [{ text: def.title, x: 42, y: 56, size: 16 }];
        if (page === 1) lines.push({ text: 'Each logical string has an authored source.', x: 42, y: 104, size: 11 }, { text: 'Glyph boxes and copy are separate witnesses.', x: 42, y: 124, size: 11 });
        if (def.mixed) lines.push({ text: def.mixed, x: 300, y, size });
        lines.push({ text: def.text, x: def.vertical ? 250 : x, y: def.vertical ? 200 : y, size, custom: true, writingMode: def.vertical ? 'vertical' : 'horizontal' });
        if (page === 1) lines.push({ text: 'Unicode boundary ends with cedar.', x: 42, y: 752, size: 10 });
        const content = def.vertical
            ? `BT /F1 ${size} Tf 1 0 0 1 250 592 Tm ${codes(def.keys)} Tj ET`
            : `BT /F1 ${size} Tf 1 0 0 1 ${x} ${792 - y} Tm ${codes(def.keys)} Tj ET`;
        lines.find(line => line.custom).operator = content;
        const target = doc.reserve();
        // RTL annotation text is UTF-16, independent of glyph codes. Its target
        // is filled only after both destination page objects have stable IDs.
        const pageId = doc.page({ lines, resources: `/F1 ${font} 0 R`, extra: `/Annots [${target} 0 R]` });
        probes.push({ page, pageId, annotationId: target, role: def.role, embedded: !def.fallback, pairedPage: def.pairedPage ?? null, logicalString: def.text,
            sourceVisualUnicode: def.visual ?? def.keys.map(key => glyphs.find(g => g.key === key).unicode).join(''), direction: def.direction,
            glyphCodes: def.keys.map(codeFor), x: def.vertical ? 250 : x, y: def.vertical ? 200 : y, size,
            perGlyphAdvancePoints: def.keys.map(key => def.vertical ? size : glyphWidth([key]) * size / 1000),
            totalRunAdvancePoints: def.vertical ? size * def.keys.length : glyphWidth(def.keys) * size / 1000,
            runDisplacementPoints: def.vertical ? [0, size * def.keys.length] : [glyphWidth(def.keys) * size / 1000, 0],
            glyphs: def.keys.map(key => { const g = glyphs.find(glyph => glyph.key === key); return { key, unicode: g.unicode, advanceFontUnits: g.width, bounds: [Math.min(...g.contours.flat().map(p => p[0])), Math.min(...g.contours.flat().map(p => p[1])), Math.max(...g.contours.flat().map(p => p[0])), Math.max(...g.contours.flat().map(p => p[1]))] }; }),
            copy: { logical: def.text, normalized: def.text.normalize('NFKC'), policy: 'Exact logical code points; native layout breaks recorded separately by P-00, not made the oracle.' },
            find: { query: def.role.startsWith('ligature-') ? 'office' : def.text.normalize('NFKC'), expectedOnThisPage: true },
            caret: def.role.startsWith('ligature-') ? { glyph: def.keys[2], canonicalInterval: [2, def.role === 'ligature-sequence' ? 4 : 3], sourceCharacters: def.role === 'ligature-sequence' ? 'fi' : '\ufb01', normalizedInterval: [2, 4], geometry: 'One glyph box for the interval; do not invent a second glyph.' } : null });
    });
    probes.forEach(probe => doc.set(probe.annotationId, `<< /Type /Annot /Subtype /Link /Rect [42 600 260 630] /Border [0 0 0] /Contents ${unicodeString(probe.page % 2 ? 'معلومة' : 'מידע')} /A << /S /GoTo /D [${doc.pageIds[probe.page === 1 ? 1 : 0]} 0 R /Fit] >> >>`));
    const outlineRoot = doc.reserve(), outlineItems = [doc.reserve(), doc.reserve(), doc.reserve(), doc.reserve()];
    ['سبب', 'אבג 123', '日本三月', '👩‍💻'].forEach((title, i) => doc.set(outlineItems[i], `<< /Title ${unicodeString(title)} /Parent ${outlineRoot} 0 R ${i ? `/Prev ${outlineItems[i - 1]} 0 R` : ''} ${i < 3 ? `/Next ${outlineItems[i + 1]} 0 R` : ''} /Dest [${doc.pageIds[i]} 0 R /Fit] >>`));
    doc.set(outlineRoot, `<< /Type /Outlines /First ${outlineItems[0]} 0 R /Last ${outlineItems[3]} 0 R /Count 4 >>`);
    const result = doc.finish(`/Outlines ${outlineRoot} 0 R /Lang (ar)`);
    const output = fixtureWriter(out);
    const record = await output('rtl-cjk-unicode.pdf', result.bytes);
    await output('rtl-cjk-unicode.expected.json', jsonBytes({ ...record, id: 'GEN-08', pages: 12, seed, generatorVersion: 1, writerVersion: 'BME raw PDF serializer v2; authored TrueType serializer v1',
        licence: 'NOASSERTION', proposedLicence: 'CC0-1.0', font: { source: 'Entirely authored diagnostic polygons in this generator; not Noto, not a copied/system font.', sha256: sha256(fontBytes), bytes: fontBytes.length, licence: 'NOASSERTION', proposedLicence: 'CC0-1.0' },
        expected: { pageModels: result.pageModels, perPage: probes, correctSelectAllText: result.pageModels.map(p => p.lines.map(l => l.text).join('\n')).join('\n\n'), correctSelectAll: { scope: 'PDF source logical text only, in physical-page/content order', source: 'Independently authored pageModels.lines[].text; sourceVisualUnicode is not the logical oracle.' },
            gestures: { title: { page: 1, from: [42, 49], to: [42 + definitions[0].title.length * 9.6, 49], correct: definitions[0].title }, twoLine: { page: 1, from: [42, 100], to: [42 + 'Glyph boxes and copy are separate witnesses.'.length * 6.6, 120], correct: 'Each logical string has an authored source.\nGlyph boxes and copy are separate witnesses.' }, crossPage: { from: { page: 1, point: [42, 748] }, to: { page: 2, point: [42 + definitions[1].title.length * 9.6, 49] }, correct: 'Unicode boundary ends with cedar.\nUnicode boundary begins with maple.' } },
            queries: [{ query: 'office', pages: [7, 8], count: 2 }], outlineTitles: ['سبب', 'אבג 123', '日本三月', '👩‍💻'], tooltipTitles: ['معلومة', 'מידע'],
            limitations: ['Diagnostic authored glyphs exercise geometry and mapping, not general Arabic shaping or production font quality.', 'Unembedded CID pages intentionally demand fallback; absent glyph ink is a recorded baseline defect, never a successful textless scan.', 'Native copy may normalize ligatures/combining sequences; raw, normalized and intended logical strings remain separate.'] } }));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const { out, seed } = parseArgs(process.argv.slice(2));
    await generateUnicode(out, seed);
}
