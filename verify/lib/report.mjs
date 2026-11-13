import { createHash, randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';

/** One append-only assertion ledger; finish writes even after a failed run. */
export async function createReport({ scratch, name, fixtures = {}, ...metadata }) {
    const directory = join(scratch, 'reports');
    await mkdir(directory, { recursive: true });
    const data = { schema: 1, name, startedAt: new Date().toISOString(), ...metadata, runId: randomUUID(),
        fixtures: Object.fromEntries(Object.entries(fixtures).map(([path, bytes]) =>
            [path, createHash('sha256').update(bytes).digest('hex')])), assertions: [], errors: [], passed: false };
    return {
        data,
        assert(label, expected, actual) {
            const passed = isDeepStrictEqual(expected, actual);
            data.assertions.push({ label, expected, actual, passed });
            if (!passed) throw new Error(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
        },
        fail(error) { data.errors.push({ name: error?.name ?? 'Error', message: String(error?.message ?? error), stack: error?.stack }); },
        async finish() {
            data.finishedAt = new Date().toISOString();
            data.passed = data.errors.length === 0 && data.assertions.length > 0 && data.assertions.every(row => row.passed);
            const path = join(directory, `${data.startedAt.replaceAll(':', '-')}-${name}-${data.runId}.json`);
            await writeFile(path, `${JSON.stringify(data, null, 2)}\n`);
            return path;
        },
    };
}
