// Builds a real production app (or a patched scratch copy), never a harness page.
import { cp, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const { values } = parseArgs({ options: {
  scratch: { type: 'string', default: '/Users/adham/Developer/bme-impl/scratch/w-b/build' },
  mutant: { type: 'boolean', default: false },
  'prefetch-mutant': { type: 'boolean', default: false },
} });
const worktree = fileURLToPath(new URL('../../..', import.meta.url));
const lock = '/Users/adham/Developer/bme-impl/scratch/bin/bme-lock';
const run = (program, args, options = {}) => new Promise((done, reject) => {
  const child = spawn(program, args, { stdio: 'inherit', ...options });
  child.on('error', reject);
  child.on('exit', code => code === 0 ? done() : reject(new Error(`${program} exited ${code}`)));
});
// Copying the mutant's independent dependencies consumes the build grant too.
if (process.env.BME_W01_BUILD_LOCKED !== '1') {
  await run(lock, ['build', '--', process.execPath, fileURLToPath(import.meta.url), ...process.argv.slice(2)], {
    cwd: worktree, env: { ...process.env, BME_W01_BUILD_LOCKED: '1' },
  });
  process.exit(0);
}
if (values.mutant && values['prefetch-mutant']) throw new Error('Choose one mutant per build');
const mutant = values.mutant ? 'registration' : values['prefetch-mutant'] ? 'prefetch' : null;
const patchFile = mutant ? `verify/whiteboard/w-b/mutants/${mutant}.patch` : null;
const git = args => execFileSync('git', args, { cwd: worktree });
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const commit = git(['rev-parse', 'HEAD']).toString().trim();
const sourceDiffSha256 = sha256(git(['diff', 'HEAD', '--', 'src']));
if (git(['ls-files', '--others', '--exclude-standard', 'src']).length) throw new Error('Untracked app source is not an identified build');
const patch = patchFile ? await readFile(resolve(worktree, patchFile)) : null;
if (patch && !patch.equals(git(['show', `${commit}:${patchFile}`]))) throw new Error('Mutant patch differs from the committed patch');
const patchSha256 = patch ? sha256(patch) : null;
const scratch = resolve(values.scratch);
if (scratch === worktree || scratch.startsWith(`${worktree}/`)) throw new Error('Build scratch must be outside the worktree');
await mkdir(scratch, { recursive: true });
const root = mutant ? await mkdtemp(resolve(scratch, 'source-')) : worktree;
if (mutant) {
  // A fresh independent copy, including dependency files. FICLONE is a
  // copy-on-write optimization where supported, never a node_modules symlink.
  await cp(worktree, root, {
    recursive: true, mode: constants.COPYFILE_FICLONE, verbatimSymlinks: true,
    filter: path => !['.git', 'dist'].includes(path.slice(worktree.length + 1).split('/')[0]),
  });
  const patchPath = resolve(worktree, patchFile);
  execFileSync('git', ['apply', '--check', patchPath], { cwd: root, stdio: 'inherit' });
  execFileSync('git', ['apply', patchPath], { cwd: root, stdio: 'inherit' });
}
const identity = { commit, sourceDiffSha256, mutant, patchFile, patchSha256, mode: 'production' };
const config = resolve(scratch, 'vite.config.mjs');
await writeFile(config, `import original from ${JSON.stringify(resolve(root, 'vite.config.ts'))};
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
export default {
  ...original,
  root: ${JSON.stringify(root)},
  cacheDir: ${JSON.stringify(resolve(scratch, 'vite-cache'))},
  build: { ...original.build, outDir: ${JSON.stringify(resolve(scratch, 'dist'))}, emptyOutDir: true },
  plugins: [...original.plugins, {
    name: 'w01-build-receipt',
    writeBundle(options, bundle) {
      const main = Object.values(bundle).find(item => item.type === 'chunk' && item.isEntry && item.facadeModuleId === ${JSON.stringify(resolve(root, 'index.html'))});
      if (!main) throw new Error('No application entry chunk');
      writeFileSync(resolve(options.dir, 'w01-build.json'), JSON.stringify({
        ...${JSON.stringify(identity)}, mainFile: main.fileName,
        mainSha256: createHash('sha256').update(readFileSync(resolve(options.dir, main.fileName))).digest('hex'),
      }));
    },
  }],
};
`);
await run(resolve(root, 'node_modules/.bin/vite'), ['build', '--config', config], { cwd: root });
console.log(JSON.stringify({ ...identity, config, dist: resolve(scratch, 'dist') }));
