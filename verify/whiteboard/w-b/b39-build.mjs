// Prepare the reference source before starting a browser; never build under a run grant.
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { buildMutant } from '../harness/mutant-build.mjs';

const { values } = parseArgs({ options: {
  scratch: { type: 'string', default: '/Users/adham/Developer/bme-impl/scratch/w-b/b39/reference' },
  'reference-commit': { type: 'string' },
  'tool-mutant': { type: 'boolean', default: false },
} });
const worktree = resolve(fileURLToPath(new URL('../../..', import.meta.url)));
const git = args => execFileSync('git', args, { cwd: worktree });
const sha = value => createHash('sha256').update(value).digest('hex');
const referenceCommit = values['reference-commit'] ?? git(['rev-parse', 'impl/reference']).toString().trim();
execFileSync('git', ['merge-base', '--is-ancestor', referenceCommit, 'impl/reference'], { cwd: worktree });
const harnessCommit = git(['rev-parse', 'HEAD']).toString().trim();
const patchFile = values['tool-mutant'] ? 'verify/whiteboard/harness/mutants/pinned-tool.patch' : null;
const patch = patchFile ? await readFile(resolve(worktree, patchFile), 'utf8') : '';
if (patch && !Buffer.from(patch).equals(git(['show', `${harnessCommit}:${patchFile}`]))) throw Error('Uncommitted toolbar mutation');
const identity = { referenceCommit, harnessCommit, mode: 'production', variant: patchFile ? 'pinned-tool' : 'reference', patchFile, patchSha256: patch ? sha(patch) : null, installLockSha256: sha(await readFile(resolve(worktree, 'package-lock.json'))) };
const descriptor = await buildMutant({ sourceTree: worktree, sourceCommit: referenceCommit, scratchRoot: values.scratch, name: identity.variant, patch, identity, receiptName: 'b39-build.json' });
await mkdir(values.scratch, { recursive: true });
await writeFile(resolve(values.scratch, 'latest.json'), JSON.stringify(descriptor, null, 2) + '\n');
console.log(JSON.stringify(descriptor));
