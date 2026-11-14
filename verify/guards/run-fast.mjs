import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fastRoot, fastScratch, lockPath, prepareFast } from '../lib/fast.mjs';

// Invoke outside a grant: both builds finish before the first run is acquired.
// Children reuse those immutable preparations; no guard is allowed to rebuild.
if (process.argv.includes('--prepare')) {
    await prepareFast();
} else {
    await mkdir(join(fastScratch, 'logs'), { recursive: true });
    const command = async (args, name) => {
        const child = spawn(lockPath, args, { cwd: fastRoot, stdio: ['ignore', 'pipe', 'pipe'] });
        let output = '';
        child.stdout.on('data', bytes => { output += bytes; });
        child.stderr.on('data', bytes => { output += bytes; });
        const code = await new Promise((resolve, reject) => {
            child.once('error', reject); child.once('exit', code => resolve(code));
        });
        const log = join(fastScratch, 'logs', `${name}.log`);
        await writeFile(log, output);
        return { code, output, log };
    };
    const prepared = await command(['build', '--', process.execPath, join(fastRoot, 'verify/guards/run-fast.mjs'), '--prepare'], 'prepare');
    if (prepared.code !== 0) throw new Error(`Preparation failed; ${prepared.log}\n${prepared.output}`);
    for (const [name, script] of [
        ['X-LAZY', 'x-lazy'], ['X-ORIGIN', 'x-origin'], ['X-NODESTROY', 'x-nodestroy'],
        ['X-MENUS', 'x-menus'], ['X-START', 'x-start'], ['X-MEDIA-notes', 'x-media-notes'],
    ]) {
        const result = await command(['run', '-w', '2', '--', process.execPath, join(fastRoot, `verify/guards/${script}.mjs`)], name);
        const summary = result.output.split('\n').find(line => line.startsWith(`${name} `));
        console.log(summary ?? `${name} FAIL ${result.log}`);
        if (result.code !== 0) process.exitCode = 1;
    }
}
