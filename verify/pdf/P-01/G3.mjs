// Browser-driven compatibility profiles. Each child drives the real app and
// closes its browser/preview; no build or in-process target arithmetic tests.
import { spawn } from 'node:child_process';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { ROOT, argumentsOf, toolbox, sha256 } from './common.mjs';

const options = argumentsOf(process.argv.slice(2), ['prepared', 'reference', 'fixture', 'scratch', 'toolbox', 'port', 'case'], ['prepared', 'reference', 'fixture', 'scratch', 'toolbox']);
const all = ['whole-to-band', 'band-to-whole', 'band-inside', 'band-outside', 'band-zoomout'];
const names = !options.case || options.case === 'all' ? all : [options.case];
if (names.some(name => !all.includes(name))) throw new Error('Unknown D1-G3 case');
const scratch = resolve(options.scratch), tools = await toolbox(options.toolbox);
await mkdir(scratch, { recursive: true });
const report = await tools.createReport({ scratch, name: 'D1-G3', gate: 'D1-G3', requested: names,
    coverage: 'Held-target compatibility work/geometry/pixel profiles; full mutant acceptance still pending',
    toolbox: tools.metadata, cases: [] });
let failed = false;
try {
    for (const name of names) {
        const output = join(scratch, name);
        await mkdir(output); // A stale child report can never stand in for this run.
        const args = [join(ROOT, 'verify/pdf/P-01/G2.mjs'), '--prepared', resolve(options.prepared), '--reference', resolve(options.reference), '--fixture', resolve(options.fixture), '--scratch', output,
            '--toolbox', resolve(options.toolbox), '--port', options.port ?? '6384', '--profile', name, '--phase', 'render'];
        const child = spawn(process.execPath, args, { cwd: ROOT, stdio: 'inherit' });
        const exit = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', (code, signal) => resolve({ code, signal })); });
        const pointer = JSON.parse(await readFile(join(output, 'latest-report.json'))), bytes = await readFile(pointer.report), result = JSON.parse(bytes);
        if (result.profile !== name || result.gate !== 'D1-G3' || result.cases.length !== 1 || result.cases[0].phase !== 'render') throw new Error('Child did not execute its named geometry arm');
        const bound = result.cases[0].servedBinding;
        if (!bound?.modules.length || bound.faults.length) throw new Error('Child has no valid served-body identity');
        report.assert(`${name}/child completed with a gate result`, true, [0, 1].includes(exit.code));
        report.data.cases.push({ name, report: pointer.report, sha256: sha256(bytes), exitCode: exit.code, passed: result.passed,
            failedAssertions: result.assertions.filter(assertion => !assertion.passed), errors: result.errors });
        if (exit.code !== 0 || !result.passed) failed = true;
    }
    report.assert('every requested geometry arm executed', names, report.data.cases.map(row => row.name));
    if (failed) report.fail(new Error('One or more named D1-G3 browser profiles failed; inspect their assertion ledgers'));
} catch (error) { failed = true; report.fail(error); }
finally {
    const path = await report.finish();
    await writeFile(join(scratch, 'latest-report.json'), JSON.stringify({ report: path, passed: report.data.passed }, null, 2) + '\n');
    console.log(JSON.stringify({ report: path, passed: report.data.passed }));
}
if (failed) process.exitCode = 1;
