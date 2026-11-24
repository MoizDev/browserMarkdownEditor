// One theme/DPR group is a bounded run. The outer serve-with launcher owns
// preview only for this group; it is stopped before the run slot is released.
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { CLASSIC_PDF_FAULT_CASES } from './cases.mjs';

const [url, identityFile, output, selection = 'all'] = process.argv.slice(2);
const names = selection === 'all' ? [...CLASSIC_PDF_FAULT_CASES] : selection.split(',');
if (!url || !identityFile || !output || process.argv.length > 6 || !names.length || new Set(names).size !== names.length || names.some(name => !CLASSIC_PDF_FAULT_CASES.includes(name))) throw new Error('Usage: run-faults.mjs <url/> <identity.json> <fresh-out> [all|comma-separated-cases]');
const theme = process.env.THEME || 'dark', dpr = Number(process.env.DPR || 1);
if (!['light', 'dark'].includes(theme) || ![1, 2].includes(dpr)) throw new Error('Invalid theme/DPR');
const out = resolve(output);
await mkdir(out);
const script = fileURLToPath(new URL('./faults.mjs', import.meta.url));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const verifierSha256 = sha(await readFile(script)), casesSha256 = sha(await readFile(new URL('./cases.mjs', import.meta.url)));
const report = { theme, dpr, requested: names, verifierSha256, casesSha256, cases: [] };
for (const name of names) {
    const directory = join(out, name);
    const child = spawnSync(process.execPath, [script, url, identityFile, directory, name], { env: process.env, stdio: 'inherit' });
    let result, setupError;
    try { result = JSON.parse(await readFile(join(directory, 'report.json'), 'utf8')); }
    catch (error) { setupError = String(error); }
    const pass = child.status === 0 && result?.pass === true && result.case === name && result.theme === theme && result.dpr === dpr
        && result.verifierSha256 === verifierSha256 && result.casesSha256 === casesSha256;
    report.cases.push({ name, exit: child.status, signal: child.signal, pass, failure: setupError || child.error?.message || result?.failure });
}
await writeFile(join(out, 'matrix.json'), `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report, null, 2));
if (report.cases.length !== names.length || report.cases.some(result => !result.pass)) process.exitCode = 1;
