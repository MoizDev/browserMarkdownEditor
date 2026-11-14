import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

// The browser gate invocation is identical for clean and mutant builds. A
// nonzero exit alone proves nothing: only the named reason is a mutant kill.
const [unguardedConfig, missingConfig] = process.argv.slice(2);
assert(unguardedConfig && missingConfig, 'Usage: node mutants.mjs UNGUARDED_CONFIG MISSING_CONFIG');
for (const [configPath, reason] of [[unguardedConfig, 'P-anchor'], [missingConfig, 'hand-count']]) {
    const config = JSON.parse(await readFile(configPath, 'utf8'));
    const result = spawnSync(process.execPath, [fileURLToPath(new URL('./funnel.mjs', import.meta.url)), configPath], { encoding: 'utf8' });
    const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
    process.stdout.write(output);
    await writeFile(join(config.artifacts, 'invocation.log'), output);
    const report = JSON.parse(await readFile(join(config.artifacts, 'result.json'), 'utf8'));
    if (result.status !== 1 || !output.split('\n').some(line => line.startsWith(`FAIL ${reason} `)) || report.reason !== reason) {
        console.error(`INVALID mutant ${configPath}: expected FAIL ${reason}, got exit=${result.status} reason=${report.reason}`);
        process.exitCode = 1;
        break;
    }
    console.log(`KILLED ${reason} browser=${report.browser} driver=${report.driver} commit=${report.commit}`);
}
