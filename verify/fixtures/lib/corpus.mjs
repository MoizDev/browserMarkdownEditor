import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { fixtureMetadata, invocations, SEED } from '../catalog.mjs';
import { sha256, writeManifest } from './output.mjs';
export const REPO = fileURLToPath(new URL('../../../', import.meta.url));
const execute = promisify(execFile);
export async function generateCorpus(out, { clockMutant = false } = {}) {
    const records = [];
    for (const invocation of invocations) {
        let generator = resolve(REPO, invocation.generator);
        if (clockMutant && invocation.key === 'core/notes') {
            const source = await readFile(generator, 'utf8');
            const anchor = "await write('Every construct.md', allConstructs)";
            if (source.split(anchor).length !== 2)
                throw new Error('Clock mutant anchor no longer matches; V-05 is unproven');
            const patched = source.replace(anchor, "await write('Every construct.md', allConstructs + `Clock: ${Date.now()} / ${process.hrtime.bigint()}\\n`)")
                .replaceAll(/from '(\.\.\/\.\.\/lib\/[^']+)'/g, (_, relative) => `from '${pathToFileURL(resolve(dirname(generator), relative)).href}'`);
            const mutant = resolve(out, 'clock-mutant.mjs');
            await mkdir(out, { recursive: true });
            await writeFile(mutant, patched, { flag: 'wx' });
            generator = mutant;
        }
        const output = resolve(out, invocation.key);
        const args = invocation.args.map(arg => arg.replace('$ROOT', out));
        const { stdout } = await execute(process.execPath, [generator, '--out', output, '--seed', String(SEED), ...args], { cwd: REPO, maxBuffer: 16 * 1024 * 1024 });
        const emitted = stdout.trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
        if (!emitted.length)
            throw new Error(`${invocation.generator} emitted no protocol records`);
        const names = new Set();
        for (const record of emitted) {
            if (!record.file || !/^[a-f0-9]{64}$/.test(record.sha256) || !Number.isSafeInteger(record.bytes) || record.bytes < 0 || names.has(record.file)) {
                throw new Error(`${invocation.generator} emitted an invalid/duplicate file record`);
            }
            names.add(record.file);
            const path = resolve(output, record.file);
            if (!path.startsWith(`${output}/`))
                throw new Error('Generator record escapes output directory');
            const bytes = await readFile(path);
            if (sha256(bytes) !== record.sha256 || bytes.length !== record.bytes)
                throw new Error(`Generator protocol hash mismatch: ${path}`);
            records.push({ invocation: invocation.key, stream: invocation.stream, ...fixtureMetadata(invocation, record) });
        }
    }
    return records;
}
export async function recordManifests(records) {
    for (const stream of ['core', 'platform']) {
        const fixtures = records.filter(record => record.stream === stream).map(record => {
            const fixture = { ...record };
            delete fixture.stream;
            return fixture;
        });
        await writeManifest(resolve(REPO, 'verify/fixtures', stream, 'manifest.json'), stream, fixtures);
    }
    const geometry = records.filter(record => record.invocation === 'platform/geometry').map(record => {
        const fixture = { ...record, canonicalManifest: 'verify/fixtures/platform/manifest.json' };
        delete fixture.stream;
        return fixture;
    });
    // PDF lanes append their own registered records here; adopting GEN-01 never deletes them.
    const path = resolve(REPO, 'verify/fixtures/pdf/manifest.json');
    let previous = [];
    try {
        previous = JSON.parse(await readFile(path, 'utf8')).fixtures;
    }
    catch (error) {
        if (error.code !== 'ENOENT')
            throw error;
    }
    await writeManifest(path, 'pdf', [...previous.filter(record => record.generator !== 'verify/fixtures/platform/generators/geometry.mjs'), ...geometry]);
}
