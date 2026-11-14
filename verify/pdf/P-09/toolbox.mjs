// Verification uses only the in-tree V-01a API; record its actual provenance.
import { readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { buildIdentity, bindServedBodies } from '../../lib/identity.mjs';
const root = fileURLToPath(new URL('../../../', import.meta.url));
const relative = 'verify/lib/identity.mjs';
const commit = execFileSync('git', ['-C', root, 'log', '-1', '--format=%H', '--', relative], { encoding: 'utf8' }).trim();
const expected = execFileSync('git', ['-C', root, 'show', `HEAD:${relative}`]);
const bytes = await readFile(new URL('../../lib/identity.mjs', import.meta.url));
const sha = value => createHash('sha256').update(value).digest('hex');
if (!commit || sha(bytes) !== sha(expected)) throw new Error('In-tree shared identity module differs from its committed bytes');
export { buildIdentity, bindServedBodies };
export const toolboxIdentity = { commit, scratch: false, files: [{ path: relative, sha256: sha(bytes), bytes: bytes.length }] };
