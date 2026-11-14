import { readFile } from 'node:fs/promises';
import { basename, extname } from 'node:path';
import { parseArgs } from '../../lib/cli.mjs';
import { fixtureWriter, jsonBytes, sha256 } from '../../lib/output.mjs';
import { seededRandom } from '../../lib/random.mjs';
const { out, seed, input } = parseArgs(process.argv.slice(2), ['input']);
if (!input)
    throw new Error('--input is required');
const source = await readFile(input);
if (source.length < 16)
    throw new Error('Damage input must contain at least 16 bytes');
const random = seededRandom(seed);
const write = fixtureWriter(out);
const extension = extname(input);
const stem = basename(input, extension);
const records = [];
for (const fraction of [0.1, 0.6, 0.99]) {
    const file = `${stem}-truncated-${Math.round(fraction * 100)}${extension}`;
    const length = Math.floor(source.length * fraction);
    await write(file, source.subarray(0, length));
    records.push({ file, kind: 'truncation', bytesKept: length, validity: 'invalid-or-repairable' });
}
const flipped = Buffer.from(source);
const offsets = [];
for (let i = 0; i < 16; i++) {
    const offset = Math.floor(random() * flipped.length);
    const bit = Math.floor(random() * 8);
    flipped[offset] ^= 1 << bit;
    offsets.push({ offset, bit });
}
await write(`${stem}-bit-flips${extension}`, flipped);
records.push({ file: `${stem}-bit-flips${extension}`, kind: 'bit-flips', offsets, validity: 'unknown' });
const depth = 4096 + Math.floor(random() * 512);
await write(`${stem}-deep-nesting.json`, `${'['.repeat(depth)}{"sourceSha256":"${sha256(source)}"}${']'.repeat(depth)}\n`);
records.push({ file: `${stem}-deep-nesting.json`, kind: 'deep-nesting', depth, validity: 'valid-json-hostile-depth' });
// A claimed count is dangerous input, not permission for a generator to allocate that many items.
const count = 2147483647 - Math.floor(random() * 1024);
const huge = extension.toLowerCase() === '.pdf'
    ? Buffer.from(`%PDF-1.7\n1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n2 0 obj << /Type /Pages /Count ${count} /Kids [] >> endobj\ntrailer << /Root 1 0 R /Size ${count} >>\n%%EOF\n`, 'ascii')
    : jsonBytes({ schema: 1, sourceSha256: sha256(source), count, items: [] });
await write(`${stem}-huge-count${extension}`, huge);
records.push({ file: `${stem}-huge-count${extension}`, kind: 'huge-count', count, validity: 'invalid' });
await write(`${stem}-damage.oracle.json`, jsonBytes({ schema: 1, seed, sourceSha256: sha256(source), sourceBytes: source.length, variants: records }));
