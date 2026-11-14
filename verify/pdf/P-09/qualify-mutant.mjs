// A failing run alone is not a working mutant: it must mount, draw and WRITE.
import { readFile, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
const [origin, fixtures, output, mutant] = process.argv.slice(2);
const variants = { 'no-guard': 'portfolio', 'null-plain': 'null-source', 'legacy-wins': 'board-with-stale-legacy', 'entry-and-funnel': 'portfolio' };
const variant = variants[mutant];
if (!variant) throw new Error('Usage: qualify-mutant.mjs ORIGIN FIXTURES OUT no-guard|null-plain|legacy-wins|entry-and-funnel');
const code = await new Promise(resolve => {
  const child = spawn(process.execPath, [new URL('./run.mjs', import.meta.url).pathname, origin, fixtures, output, variant, 'toolbar', 'refused'], { stdio: 'inherit', env: process.env });
  child.on('exit', resolve);
});
const observation = JSON.parse(await readFile(path.join(output, `${variant}-toolbar.json`)));
const qualified = code !== 0 && !observation.passed && !observation.identityFailure
  && observation.mutant?.mutant === mutant && observation.executedArms?.filter(arm => arm === 'toolbar').length === 1
  && observation.failure?.includes('Read-only role guard failed') && observation.errors.length === 0
  && observation.editable && observation.writes.includes('guard.pdf') && observation.outputSha256 !== observation.fixtureSha256;
await writeFile(path.join(output, 'qualification.json'), `${JSON.stringify({ mutant, qualified, observation: `${variant}-toolbar.json`, falsePass: 'A crash, blank PDF or notice alone cannot qualify: the mutant must mount an editable canvas, draw and close a real OPFS write.' }, null, 2)}\n`);
if (!qualified) throw new Error('UNPROVEN mutant: no observed editable-canvas write');
