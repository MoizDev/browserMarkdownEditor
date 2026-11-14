import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { buildIdentity } from '../lib/substitute.mjs';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const scratch = process.env.BME_SCRATCH ?? '/Users/adham/Developer/bme-impl/scratch/c-c/c07b';
const mode = process.env.BME_MODE ?? 'benchmark';
const distDir = process.env.BME_DIST ?? resolve(scratch, `dist/${mode}`);
const identity = await buildIdentity({ worktree: root, distDir: mode === 'dev' ? undefined : distDir, patch: process.env.BME_PATCH });
await mkdir(resolve(scratch, 'prepared'), { recursive: true });
await writeFile(resolve(scratch, `prepared/${mode}.json`), JSON.stringify({ mode, distDir, identity }, null, 2));
console.log(JSON.stringify({ prepared: mode, commit: identity.commit, manifest: identity.manifestSha256, sourceDiff: identity.sourceDiffSha256 }));
