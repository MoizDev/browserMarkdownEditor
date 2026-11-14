// Temporary single-file bridge until v-b's verify/fixtures/lib reaches impl/pdf.
// Matches its published API/defaults; replace imports and delete this file then.
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';
import { PDFDocument, PDFHexString } from 'pdf-lib';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
export const jsonBytes = value => Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
export function parseArgs(argv) {
    const values = {};
    for (let i = 0; i < argv.length; i += 2) {
        const key = argv[i]?.replace(/^--/, ''), value = argv[i + 1];
        if (!argv[i]?.startsWith('--') || !['out', 'seed'].includes(key) || value === undefined || key in values) throw new Error('Expected unique --out and --seed switches with values');
        values[key] = value;
    }
    if (!values.out || !/^(0|[1-9][0-9]*)$/.test(values.seed ?? '') || Number(values.seed) > 0xffffffff) throw new Error('--out and an unsigned 32-bit --seed are required');
    return { out: resolve(values.out), seed: Number(values.seed) };
}
export function fixtureWriter(out) {
    const root = resolve(out);
    return async (file, content) => {
        if (!file || file.includes('\\') || file.startsWith('/') || file.split('/').some(part => !part || part === '.' || part === '..')) throw new Error('Not a portable fixture name');
        const target = resolve(root, file);
        if (!target.startsWith(`${root}${sep}`)) throw new Error('Fixture output escapes its directory');
        const bytes = typeof content === 'string' ? Buffer.from(content, 'utf8') : Buffer.from(content);
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, bytes, { flag: 'wx' });
        const record = { file, sha256: sha(bytes), bytes: bytes.length };
        process.stdout.write(`${JSON.stringify(record)}\n`);
        return record;
    };
}
function pin(doc, { id, version = 1, seed }) {
    const digest = sha(`${id}\n${version}\n${seed}\n`).slice(0, 32);
    doc.setCreationDate(new Date('2000-01-01T00:00:00.000Z'));
    doc.setModificationDate(new Date('2000-01-01T00:00:00.000Z'));
    doc.setProducer('Browser fixture writer v1 / pdf-lib 1.17.1');
    doc.setCreator('Reproducible browser inputs'); doc.setTitle(id);
    doc.context.trailerInfo.ID = doc.context.obj([PDFHexString.of(digest), PDFHexString.of(digest)]);
    doc.context.rng.seed = seed;
    return doc;
}
export async function createDeterministicPdf(identity) { return pin(await PDFDocument.create({ updateMetadata: false }), identity); }
export async function saveDeterministicPdf(doc, identity) {
    pin(doc, identity);
    return doc.save({ useObjectStreams: false, objectsPerTick: Infinity, addDefaultPage: false });
}
