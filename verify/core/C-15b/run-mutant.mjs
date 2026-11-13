import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const split = args.indexOf('--');
const reason = args[args.indexOf('--expect') + 1];
if (split < 0 || !['P-anchor', 'hand-count', 'directory-precedence'].includes(reason)) {
    console.error('INVALID mutant invocation: --expect P-anchor|hand-count|directory-precedence -- <normal run.mjs arguments>');
    process.exit(2);
}
const result = spawnSync(process.execPath, [fileURLToPath(new URL('./run.mjs', import.meta.url)), ...args.slice(split + 1)], {
    encoding: 'utf8', maxBuffer: 16 * 1024 * 1024,
});
process.stdout.write(result.stdout ?? '');
process.stderr.write(result.stderr ?? '');
if (result.status !== 1 || !new RegExp(`^FAIL ${reason}(?: |$)`, 'm').test(result.stderr ?? '')) {
    console.error(`INVALID mutant execution: expected exit 1 and FAIL ${reason}, got ${result.status}; setup/identity errors are not kills`);
    process.exit(2);
}
console.log(`KILLED ${reason}`);
