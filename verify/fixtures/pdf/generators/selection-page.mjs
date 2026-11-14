import { mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';

// Courier's fixed advance makes the drag's expected prefix independent of an
// installed font. Coordinates are recorded in PDF points, with a top-left origin.
const title = 'Selection starts at the margin';
const lines = [
  { text: title, x: 92, y: 92, size: 20 },
  ...Array.from({ length: 12 }, (_, i) => ({ text: `Left column line ${String(i + 1).padStart(2, '0')}`, x: 72, y: 152 + i * 20, size: 12 })),
  ...Array.from({ length: 12 }, (_, i) => ({ text: `Right column line ${String(i + 1).padStart(2, '0')}`, x: 330, y: 152 + i * 20, size: 12 })),
];
const args = process.argv.slice(2);
if (args.length !== 4 || args[0] !== '--out' || args[2] !== '--seed' || !/^\d+$/.test(args[3])) {
  throw new Error('Usage: --out <directory> --seed <uint32>');
}
const seed = Number(args[3]);
if (!Number.isSafeInteger(seed) || seed < 0 || seed > 0xffffffff) throw new Error('Seed must be uint32');
const out = resolve(args[1]);
await mkdir(out, { recursive: true });

function pdf(pageCount, fixtureId) {
  const id = createHash('sha256').update(`${fixtureId}:1:${seed}`).digest('hex').slice(0, 32);
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '', '<< /Type /Font /Subtype /Type1 /BaseFont /Courier >>',
    '<< /CreationDate (D:20000101000000Z) /ModDate (D:20000101000000Z) /Producer (BME raw PDF writer 1) /Creator (BME selection generator 1) >>'];
  const kids = [];
  for (let i = 0; i < pageCount; i++) {
    const pageId = objects.length + 1;
    kids.push(`${pageId} 0 R`);
    const content = lines.map(l => `BT /F1 ${l.size} Tf 1 0 0 1 ${l.x} ${792 - l.y} Tm (${l.text}) Tj ET`).join('\n');
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${pageId + 1} 0 R >>`);
    objects.push(`<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`);
  }
  objects[1] = `<< /Type /Pages /Count ${pageCount} /Kids [${kids.join(' ')}] >>`;
  let text = '%PDF-1.7\n';
  const offsets = [0];
  for (let i = 0; i < objects.length; i++) {
    offsets.push(Buffer.byteLength(text));
    text += `${i + 1} 0 obj\n${objects[i]}\nendobj\n`;
  }
  const start = Buffer.byteLength(text);
  text += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.slice(1).map(n => `${String(n).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R /Info 4 0 R /ID [<${id}><${id}>] >>\nstartxref\n${start}\n%%EOF\n`;
  return Buffer.from(text);
}

async function emit(file, bytes) {
  await writeFile(resolve(out, file), bytes, { flag: 'wx' });
  const entry = { file, sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length };
  console.log(JSON.stringify(entry));
  return entry;
}
const fixtures = [];
for (const [file, pages] of [['selection-page.pdf', 1], ['dense-40-selection.pdf', 40]]) {
  fixtures.push({ ...await emit(file, pdf(pages, file)), pages });
}
await emit('selection-geometry.json', Buffer.from(JSON.stringify({
  fixtures, page: { width: 612, height: 792 }, lines,
  marginStart: { x: 62, y: 87 }, titleEnd: { x: 92 + 12 * 16, y: 87 },
  titlePrefix: title.slice(0, 16), nativeStart: { x: 92 + 12 * 3, y: 87 },
  nativeText: title.slice(3, 16),
  multilineStart: { x: 74, y: 147 }, multilineEnd: { x: 72 + 7.2 * 12, y: 167 },
  // Native selections include line breaks. R3b compares the whitespace-normalized
  // clipboard with this independently generated text, never with the text-layer DOM.
  normalizedPageText: lines.map(l => l.text).join(' '),
}, null, 2) + '\n'));
