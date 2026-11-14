import { parseArgs } from 'node:util';
import { resolve } from 'node:path';
import { prepareApp } from '../../lib/serve.mjs';

// Preparation is intentionally separate: no browser run can nest a build grant.
const { values } = parseArgs({ options: { root: { type: 'string' }, scratch: { type: 'string' } } });
if (!values.root || !values.scratch) throw new Error('Supply --root <worktree> --scratch <outside-build-dir>');
const prepared = await prepareApp({ root: resolve(values.root), scratch: resolve(values.scratch), mode: 'benchmark' });
console.log(JSON.stringify({ root: prepared.root, scratch: prepared.scratch, identity: prepared.identity }));
