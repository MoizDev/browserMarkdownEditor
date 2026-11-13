// Authored PDF/CCITT data; no third-party document or font bytes.
// Proposed CC0-1.0; licence remains NOASSERTION pending the owner's choice.
// This GEN-09 slice is deliberately NOT a replacement for the risky JPX/JBIG2
// witnesses: reproducing their precise constructions needs a pinned encoder.
import { mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';

const args = process.argv.slice(2);
if (args.length !== 4 || args[0] !== '--out' || args[2] !== '--seed' || !/^\d+$/.test(args[3])) throw new Error('Usage: --out <directory> --seed <uint32>');
const out = resolve(args[1]);
const seed = Number(args[3]);
if (!Number.isSafeInteger(seed) || seed < 0 || seed > 0xffffffff) throw new Error('Seed must be uint32');
await mkdir(out, { recursive: true });
const version = 2;
const bytes = value => Buffer.from(value, 'latin1');
const stream = (dict, data) => Buffer.concat([bytes(`<< ${dict} /Length ${data.length} >>\nstream\n`), data, bytes('\nendstream')]);
function pdf(objects, fixtureId) {
    objects = [...objects, '<< /CreationDate (D:20000101000000Z) /ModDate (D:20000101000000Z) /Creator (Authored codec fixtures) /Producer (codecs-minimal v2) >>'];
    const id = createHash('sha256').update(`${fixtureId}:${version}:${seed}`).digest('hex').slice(0, 32);
    const parts = [bytes('%PDF-1.7\n%\xe2\xe3\xcf\xd3\n')];
    const offsets = [0];
    let length = parts[0].length;
    for (const [i, object] of objects.entries()) {
        offsets.push(length);
        const part = Buffer.concat([bytes(`${i + 1} 0 obj\n`), typeof object === 'string' ? bytes(object) : object, bytes('\nendobj\n')]);
        parts.push(part);
        length += part.length;
    }
    parts.push(bytes(`xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.slice(1).map(n => `${String(n).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R /Info ${objects.length} 0 R /ID [<${id}><${id}>] >>\nstartxref\n${length}\n%%EOF\n`));
    return Buffer.concat(parts);
}
function imagePdf(filter, params, image, fixtureId) {
    return pdf([
        '<< /Type /Catalog /Pages 2 0 R >>',
        '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
        '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 256 256] /Resources << /XObject << /Im0 5 0 R >> >> /Contents 4 0 R >>',
        stream('', bytes('q 224 0 0 224 16 16 cm /Im0 Do Q')),
        stream(`/Type /XObject /Subtype /Image /Width 16 /Height 16 /ColorSpace /DeviceGray /BitsPerComponent 1 /Filter /${filter} /Decode [1 0] ${params}`, image),
    ], fixtureId);
}
function bitBytes(bits) {
    const padded = bits.padEnd(Math.ceil(bits.length / 8) * 8, '0');
    return Buffer.from(padded.match(/.{8}/g).map(b => Number.parseInt(b, 2)));
}
const fixtures = [];
async function emit(file, data, expected) {
    await writeFile(resolve(out, file), data, { flag: 'wx' });
    const entry = { id: `GEN-09-${file.replace('.pdf', '')}`, file, sha256: createHash('sha256').update(data).digest('hex'), bytes: data.length, seed, version, pages: 1, licence: 'NOASSERTION', proposedLicence: 'CC0-1.0', expected };
    fixtures.push(entry);
    console.log(JSON.stringify({ file, sha256: entry.sha256, bytes: entry.bytes }));
}
// T.6 horizontal mode 001, T.4 terminating white run 8 = 10011,
// black run 8 = 000101. Each independently encoded row is half black.
for (const endOfBlock of [false, true]) {
    const encoded = bitBytes('00110011000101'.repeat(16) + (endOfBlock ? '000000000001000000000001' : ''));
    await emit(`ccitt-g4-eob-${endOfBlock}.pdf`, imagePdf('CCITTFaxDecode', `/DecodeParms << /K -1 /Columns 16 /Rows 16 /BlackIs1 true /EndOfBlock ${endOfBlock} >>`, encoded, `GEN-09-ccitt-g4-eob-${endOfBlock}`), {
        geometry: [256, 256], ink: [128, 16, 112, 224], paper: [16, 16, 112, 224], codec: 'CCITT G4',
    });
}
const cmap = bytes('/CIDInit /ProcSet findresource begin\n12 dict begin\nbegincmap\n/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def\n/CMapName /AuthoredUnicode def\n/CMapType 2 def\n1 begincodespacerange\n<0000> <FFFF>\nendcodespacerange\n2 beginbfchar\n<4E2D> <4E2D>\n<6587> <6587>\nendbfchar\nendcmap\nCMapName currentdict /CMap defineresource pop\nend\nend');
await emit('cjk-nonembedded.pdf', pdf([
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 256 256] /Resources << /Font << /F0 5 0 R >> >> /Contents 4 0 R >>',
    stream('', bytes('BT /F0 48 Tf 64 128 Td <4E2D6587> Tj ET')),
    '<< /Type /Font /Subtype /Type0 /BaseFont /STSong-Light /Encoding /UniGB-UCS2-H /DescendantFonts [6 0 R] /ToUnicode 8 0 R >>',
    '<< /Type /Font /Subtype /CIDFontType0 /BaseFont /STSong-Light /CIDSystemInfo << /Registry (Adobe) /Ordering (GB1) /Supplement 5 >> /FontDescriptor 7 0 R /DW 1000 >>',
    '<< /Type /FontDescriptor /FontName /STSong-Light /Flags 6 /FontBBox [-25 -254 1000 880] /ItalicAngle 0 /Ascent 752 /Descent -271 /CapHeight 737 /StemV 58 >>',
    stream('', cmap),
], 'GEN-09-cjk-nonembedded'), { geometry: [256, 256], text: '\u4e2d\u6587', codec: 'non-embedded CJK', glyphOracle: 'NOT ESTABLISHED: outline comparison requires an independently approved font reference' });
await emit('white.pdf', pdf([
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 256 256] /Resources << >> /Contents 4 0 R >>',
    stream('', bytes('')),
], 'GEN-09-white'), { geometry: [256, 256], blank: true });
const file = 'codecs-minimal.oracle.json';
const oracle = Buffer.from(`${JSON.stringify({ generator: 'GEN-09 slice', version, seed, fixtures, gaps: ['JPX/JBIG2 encoders and exact negative constructions', 'DCT encoder', 'independent CJK glyph-outline oracle'] }, null, 2)}\n`);
await writeFile(resolve(out, file), oracle, { flag: 'wx' });
console.log(JSON.stringify({ file, sha256: createHash('sha256').update(oracle).digest('hex'), bytes: oracle.length }));
