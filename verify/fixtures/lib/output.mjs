import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';
export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
export const jsonBytes = value => Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
export const compareNames = (a, b) => a < b ? -1 : a > b ? 1 : 0;
export function fixtureWriter(out) {
    const root = resolve(out);
    return async (file, content) => {
        if (!file || file.includes('\\') || file.startsWith('/') || file.split('/').some(p => !p || p === '.' || p === '..')) {
            throw new Error(`Not a portable relative fixture name: ${file}`);
        }
        const target = resolve(root, file);
        if (!target.startsWith(`${root}${sep}`))
            throw new Error(`Output escapes its directory: ${file}`);
        const bytes = typeof content === 'string' ? Buffer.from(content, 'utf8') : Buffer.from(content);
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, bytes, { flag: 'wx' });
        const record = { file, sha256: sha256(bytes), bytes: bytes.length };
        process.stdout.write(`${JSON.stringify(record)}\n`);
        return record;
    };
}
export async function writeManifest(path, stream, fixtures) {
    await mkdir(dirname(path), { recursive: true });
    const sorted = [...fixtures].sort((a, b) => compareNames(a.id, b.id));
    if (new Set(sorted.map(record => record.id)).size !== sorted.length)
        throw new Error(`Duplicate fixture id in ${stream}`);
    await writeFile(path, jsonBytes({ schema: 1, stream, fixtures: sorted }));
}
