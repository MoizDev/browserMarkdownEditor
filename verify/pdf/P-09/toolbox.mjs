// Until V-01a is merged, p-lead authorizes an OWN unmodified scratch export of
// this exact commit. Missing/edited tooling is a harness failure, never fallback.
import { readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const root = fileURLToPath(new URL('../../../', import.meta.url));
const relative = 'verify/lib/identity.mjs';
const scratch = process.env.P09_TOOLBOX_ROOT;
const file = scratch ? resolve(scratch, relative) : resolve(root, relative);
const commit = scratch
    ? execFileSync('git', ['-C', root, 'rev-parse', '527faea^{commit}'], { encoding: 'utf8' }).trim()
    : execFileSync('git', ['-C', root, 'log', '-1', '--format=%H', '--', relative], { encoding: 'utf8' }).trim();
if (!commit) throw new Error('The shared identity module has no committed provenance');
const expected = execFileSync('git', ['-C', root, 'show', `${scratch ? commit : 'HEAD'}:${relative}`]);
const bytes = await readFile(file);
const sha = value => createHash('sha256').update(value).digest('hex');
if (sha(bytes) !== sha(expected)) throw new Error('Shared identity module differs from its committed bytes');
const module = await import(pathToFileURL(file).href);
if (typeof module.buildIdentity !== 'function' || typeof module.bindServedBodies !== 'function') throw new Error('Unknown shared identity API');
export const { buildIdentity, bindServedBodies } = module;
export const toolboxIdentity = { commit, scratch: !!scratch, files: [{ path: relative, sha256: sha(bytes), bytes: bytes.length }] };
