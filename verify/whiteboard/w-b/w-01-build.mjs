// Builds a real production app (or a patched scratch copy), never a harness page.
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const { values } = parseArgs({ options: {
  scratch: { type: 'string', default: '/Users/adham/Developer/bme-impl/scratch/w-b/build' },
  mutant: { type: 'boolean', default: false },
} });
const worktree = fileURLToPath(new URL('../../..', import.meta.url));
const scratch = resolve(values.scratch);
const root = values.mutant ? resolve(scratch, 'source') : worktree;
const lock = '/Users/adham/Developer/bme-impl/scratch/bin/bme-lock';
const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: worktree, encoding: 'utf8' }).trim();
const sourceDiffSha256 = createHash('sha256').update(execFileSync('git', ['diff', 'HEAD', '--', 'src'], { cwd: worktree })).digest('hex');
await mkdir(scratch, { recursive: true });
if (values.mutant) {
  // An independent copy, including its own dependency files. FICLONE is a
  // copy-on-write optimization where supported, never a node_modules symlink.
  await cp(worktree, root, {
    recursive: true, mode: constants.COPYFILE_FICLONE,
    filter: path => !['.git', 'dist'].includes(path.slice(worktree.length + 1).split('/')[0]),
  });
  const file = resolve(root, 'src/utils/fileTypes.ts');
  const before = await readFile(file, 'utf8');
  const anchor = 'return isDrawingFile(name) || isNativeDrawingFile(name) || isNotebookFile(name);';
  if (before.split(anchor).length !== 2) throw new Error('Mutant patch no longer applies exactly once');
  await writeFile(file, before.replace(anchor, 'return isDrawingFile(name) || isNotebookFile(name);'));
}
const identity = { commit, sourceDiffSha256, mutant: values.mutant ? 'isCanvasFile omits .drawing' : null, mode: 'production' };
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
const child = spawn(lock, ['build', '--', resolve(root, 'node_modules/.bin/vite'), 'build', '--config', config], { cwd: root, stdio: 'inherit' });
const code = await new Promise((done, reject) => { child.on('error', reject); child.on('exit', done); });
if (code !== 0) throw new Error(`Production build failed: ${code}`);
console.log(JSON.stringify({ ...identity, config, dist: resolve(scratch, 'dist') }));
