// Sequential real-app runs: one browser at a time, one weighted run grant.
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
const [origin, fixtureDir, outputDir, manifestPath] = process.argv.slice(2);
if (!manifestPath) throw new Error('Usage: corpus.mjs ORIGIN FIXTURES OUTPUT MANIFEST');
const manifest = JSON.parse(await readFile(manifestPath));
await mkdir(outputDir, { recursive: true });
const entries = process.env.ENTRIES?.split(',') ?? ['toolbar', 'keyboard', 'restore'];
if (!entries.length || new Set(entries).size !== entries.length || entries.some(entry => !['toolbar', 'keyboard', 'restore', 'reload'].includes(entry))) throw new Error('Unknown or duplicate named entry arm');
const requested = process.env.ONLY?.split(',');
const fixtures = manifest.fixtures.filter(fixture => fixture.id.startsWith('GEN-25/') && fixture.file.endsWith('.pdf'));
if (!fixtures.length || requested?.some(name => !fixtures.some(fixture => fixture.file === `${name}.pdf`))) throw new Error('Unknown or absent requested GEN-25 fixture');
const selected = fixtures.filter(fixture => !requested || requested.includes(fixture.file.replace(/\.pdf$/, '')));
const results = [];
for (const fixture of selected) {
  for (const entry of entries) {
    const variant = fixture.file.replace(/\.pdf$/, '');
    const code = await new Promise(resolve => {
      const child = spawn(process.execPath, [new URL('./run.mjs', import.meta.url).pathname, origin, fixtureDir, outputDir, variant, entry, fixture.expected], { stdio: 'inherit', env: process.env });
      child.on('exit', resolve);
    });
    const report = JSON.parse(await readFile(path.join(outputDir, `${variant}-${entry}.json`)));
    if (report.fixtureSha256 !== fixture.sha256) throw new Error(`Fixture identity changed: ${fixture.id}`);
    results.push({ fixture: fixture.id, entry, passed: code === 0 && report.passed && report.executedArms?.filter(arm => arm === entry).length === 1, report: `${variant}-${entry}.json` });
  }
}
const summary = { passed: results.length === selected.length * entries.length && results.every(result => result.passed), requestedEntries: entries, selectedFixtures: selected.map(fixture => fixture.id), results, notRun: ['real helper/agent entry (V-02)', 'save-funnel-only mutant on App seam', 'real qualified pristine capacity boundary', 'worker death specifically during attachment decode', 'exhaustive malformed/schema/async interleavings'] };
await writeFile(path.join(outputDir, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
if (!summary.passed) process.exitCode = 1;
