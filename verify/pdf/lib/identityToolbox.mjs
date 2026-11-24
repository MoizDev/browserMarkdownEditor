// Report provenance for the in-tree shared toolbox; never import an app module.
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';

export async function loadIdentityToolbox() {
    const moduleUrl = new URL('../../lib/identity.mjs', import.meta.url);
    const git = args => execFileSync('git', args, { encoding: 'utf8' }).trim();
    const commit = git(['rev-parse', 'HEAD']);
    const bytes = await readFile(moduleUrl);
    const committed = execFileSync('git', ['show', `${commit}:verify/lib/identity.mjs`]);
    if (!bytes.equals(committed)) throw new Error('Identity toolbox differs from its declared committed source');
    return { ...await import(moduleUrl.href), toolboxIdentity: { commit, file: 'verify/lib/identity.mjs', sha256: createHash('sha256').update(bytes).digest('hex') } };
}
