import { spawnSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const [kind, baseArg, fixtureArg, outArg] = process.argv.slice(2);
if (process.argv.length !== 6 || !['hyphen', 'abort'].includes(kind)) throw new Error('Usage: mutant-proof.mjs <hyphen|abort> <prepared mutant base> <fixture dir> <fresh output dir>');
const base = resolve(baseArg), out = resolve(outArg), fixtures = resolve(fixtureArg);
if (!base.startsWith('/Users/adham/Developer/bme-impl/scratch/p-b/') || !out.startsWith('/Users/adham/Developer/bme-impl/scratch/p-b/')) throw new Error('Use this lane scratch');
await mkdir(out); // Stale result JSON must never kill a mutant.
const cases = [];
for (const theme of ['dark', 'light']) for (const dpr of [1, 2]) {
    const output = resolve(out, `${theme}-${dpr}`);
    const env = { ...process.env, BME_MODE: 'production', BME_ROOT: resolve(base, 'source'), BME_SCRATCH: resolve(base, 'build'), BME_MUTANT: kind,
        BME_PORT: kind === 'hyphen' ? '6402' : '6403', BME_FIXTURES: fixtures, BME_OUT: output, BME_THEME: theme, BME_DPR: String(dpr),
        BME_TEXTBOOK: kind === 'abort' ? '1' : '0', BME_LIFECYCLE: kind === 'abort' ? '1' : '0', BME_HIDE: '0', BME_CAP: '0', BME_CORRUPT: '0' };
    if (kind === 'hyphen') delete env.BME_FIXTURE_MANIFEST;
    const child = spawnSync(process.execPath, [fileURLToPath(new URL('./run.mjs', import.meta.url))], { env, encoding: 'utf8', timeout: 180_000, maxBuffer: 1024 * 1024 });
    let result, readFailure;
    try { result = JSON.parse(await readFile(resolve(output, 'results.json'), 'utf8')); } catch (error) { readFailure = String(error); }
    const expectedFailure = kind === 'abort'
        ? result?.namedFailure === 'Refine published results from the aborted query' && result.refine?.stale.length > 0
        : result?.namedFailure === 'Find corpus mismatch; see results.json' && result.observations?.length === 13 &&
            result.observations.filter(item => !item.pass).map(item => item.query).sort().join('|') === 'state-of-the-art|transformation';
    const killed = child.status === 1 && !child.error && result?.pass === false && result.phase === 'functional' && expectedFailure &&
        result.errors.length === 0 && !result.artifactFailure && result.identity.build.patchSha256 && result.identity.build.mutant.name === kind &&
        result.servedBinding?.modules.length > 0 && result.servedBinding.faults.length === 0;
    cases.push({ theme, dpr, killed: Boolean(killed), status: child.status, error: child.error?.message, readFailure,
        namedFailure: result?.namedFailure, buildIdentity: result?.identity?.build?.manifestSha256, results: resolve(output, 'results.json'), stdout: child.stdout, stderr: child.stderr });
}
const pass = cases.length === 4 && cases.every(item => item.killed);
await writeFile(resolve(out, 'proof.json'), JSON.stringify({ kind, pass, cases }, null, 2) + '\n');
console.log(JSON.stringify({ kind, pass, cases: cases.map(({ theme, dpr, killed, namedFailure }) => ({ theme, dpr, killed, namedFailure })), proof: resolve(out, 'proof.json') }, null, 2));
if (!pass) process.exitCode = 1;
