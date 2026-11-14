// Four real-browser runs, serial under one run slot. A mutant is killed only
// by its named observable failure after every fixture arm actually executed.
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const [url, fixtures, output, identityFile, mode] = process.argv.slice(2);
if (process.argv.length !== 7 || !url || !fixtures || !output || !identityFile || !['local', 'generated'].includes(mode)) throw new Error('Usage: run-matrix.mjs <url/> <fixtures> <fresh-results-dir> <artifact-identity.json> <generated|local>');
const identity = JSON.parse(await readFile(identityFile, 'utf8'));
if (![null, 'missing-wasm'].includes(identity.mutant)) throw new Error('Unknown mutant');
const out = resolve(output);
await mkdir(out);
const script = fileURLToPath(new URL('./view-codecs.mjs', import.meta.url));
const verifierSha256 = createHash('sha256').update(await readFile(script)).digest('hex');
const matrix = { gate: 'P-02a theme/DPR matrix', mutant: identity.mutant, verifierSha256, cases: [] };
for (const theme of ['dark', 'light']) for (const dpr of [1, 2]) {
    const directory = join(out, `${theme}-${dpr}`);
    const child = spawnSync(process.execPath, [script, url, fixtures, directory, identityFile, mode], {
        env: { ...process.env, THEME: theme, DPR: String(dpr) }, stdio: 'inherit',
    });
    let report, readError;
    try { report = JSON.parse(await readFile(join(directory, 'report.json'), 'utf8')); }
    catch (error) { readError = String(error); }
    const ran = !readError && !report.failure && report.verifierSha256 === verifierSha256 && report.theme === theme && report.dpr === dpr
        && report.markdown?.executed === 1 && report.cases.length === (mode === 'local' ? 8 : 4)
        && report.cases.every(c => c.executed === 1);
    const pass = ran && (identity.mutant === 'missing-wasm' ? child.status === 1 && report.namedMutantFailure === true : child.status === 0 && report.cases.every(c => c.pass) && report.positiveControl === true);
    matrix.cases.push({ theme, dpr, exit: child.status, signal: child.signal, setupError: child.error?.message || readError || report?.failure, ran, pass });
}
await writeFile(join(out, 'matrix.json'), `${JSON.stringify(matrix, null, 2)}\n`);
console.log(JSON.stringify(matrix, null, 2));
if (matrix.cases.length !== 4 || matrix.cases.some(c => !c.pass)) process.exitCode = 1;
