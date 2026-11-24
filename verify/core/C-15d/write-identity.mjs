import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

// Build metadata, not a gate: the browser later checks the identity of every
// served body it scans. This file supplies paths/hashes, never asserted content.
const args = Object.fromEntries(process.argv.slice(2).map(arg => {
    const at = arg.indexOf('=');
    return [arg.slice(2, at), arg.slice(at + 1)];
}));
if (!args.output || !['production', 'benchmark'].includes(args.mode)) throw new Error('identity setup: supply --output=outDir --mode=production|benchmark');
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const output = path.resolve(args.output);
const commit = args.commit ?? execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
let tree;
if (args.patch) tree = { patchSha256: sha256(await readFile(args.patch)) };
else {
    const status = execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' });
    if (status) throw new Error(`identity setup: source worktree must be clean: ${status}`);
    tree = { clean: true };
}
const files = {};
async function inventory(dir) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
        const file = path.join(dir, entry.name);
        if (entry.isDirectory()) await inventory(file);
        else if (entry.isFile()) files[path.relative(output, file).split(path.sep).join('/')] = sha256(await readFile(file));
    }
}
await inventory(output);
await writeFile(`${output}.identity.json`, JSON.stringify({ commit, tree, mode: args.mode, files }, null, 2) + '\n');
console.log(`Identity: ${output}.identity.json`);
