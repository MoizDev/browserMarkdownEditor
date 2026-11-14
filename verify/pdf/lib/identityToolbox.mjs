// Temporary prelude adapter: only the committed verification toolbox is loaded,
// never an app module. The default becomes in-tree when V-01a is integrated.
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export async function loadIdentityToolbox() {
    const moduleUrl = process.env.VERIFY_IDENTITY_MODULE ? pathToFileURL(resolve(process.env.VERIFY_IDENTITY_MODULE)) : new URL('../../lib/identity.mjs', import.meta.url);
    const git = args => execFileSync('git', args, { encoding: 'utf8' }).trim();
    const commit = git(['rev-parse', process.env.VERIFY_TOOLBOX_COMMIT ?? 'HEAD']);
    const bytes = await readFile(moduleUrl);
    const committed = execFileSync('git', ['show', `${commit}:verify/lib/identity.mjs`]);
    if (!bytes.equals(committed)) throw new Error('Identity toolbox differs from its declared committed source');
    return { ...await import(moduleUrl.href), toolboxIdentity: { commit, file: 'verify/lib/identity.mjs', sha256: createHash('sha256').update(bytes).digest('hex') } };
}
