// Source logic mutants are real production builds, prepared BEFORE a browser grant.
import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
const LOCK = '/Users/adham/Developer/bme-impl/scratch/bin/bme-lock';
const modulePath = fileURLToPath(import.meta.url);
const sha = value => createHash('sha256').update(value).digest('hex');
const inside = (parent, child) => child === parent || child.startsWith(parent + path.sep);
const cleanEnv = () => {
  const env = { ...process.env };
  for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR']) delete env[key];
  return env;
};
const command = (file, args, options = {}) => new Promise((done, reject) => {
  const child = spawn(file, args, { stdio: 'inherit', env: cleanEnv(), ...options });
  child.on('error', reject);
  child.on('exit', code => code === 0 ? done() : reject(Error(`${file} exited ${code}; build before acquiring a run grant`)));
});

export async function buildMutant({ sourceTree, sourceCommit, scratchRoot, name, patch = '', identity = {}, markerSpecs = [], receiptName = 'mutant-build.json' }) {
  if (!sourceTree || !sourceCommit || !scratchRoot || !/^[\w-]{1,60}$/.test(name ?? '')) throw Error('buildMutant requires sourceTree/sourceCommit/scratchRoot/safe name');
  if (!/^[0-9a-f]{40}$/.test(sourceCommit) || !/^[\w-]+\.json$/.test(receiptName)) throw Error('Invalid build identity/receipt name');
  const source = await fs.realpath(sourceTree);
  const root = path.resolve(scratchRoot);
  if (inside(source, root)) throw Error('Build scratch must be outside the source repository');
  await fs.mkdir(root, { recursive: true });
  const directory = await fs.mkdtemp(path.join(root, `${name}-`));
  const jobPath = path.join(directory, 'job.json');
  await fs.writeFile(jobPath, JSON.stringify({ source, sourceCommit, directory, patch, identity, markerSpecs, receiptName }));
  // The lock covers the archive, independent dependency copy and Vite. Calling
  // this from inside a run grant is deliberately refused by the shared lock.
  await command(LOCK, ['build', '--', process.execPath, modulePath, '--job', jobPath]);
  return JSON.parse(await fs.readFile(path.join(directory, 'manifest.json'), 'utf8'));
}

async function perform(jobPath) {
  const job = JSON.parse(await fs.readFile(jobPath, 'utf8'));
  const { source, sourceCommit, directory, patch, identity, markerSpecs, receiptName } = job;
  const tree = path.join(directory, 'source'), outDir = path.join(directory, 'dist');
  await fs.mkdir(tree);
  const archivePath = path.join(directory, 'source.tar');
  const archive = execFileSync('git', ['archive', '--format=tar', sourceCommit], { cwd: source, env: cleanEnv(), maxBuffer: 256 * 1024 * 1024 });
  await fs.writeFile(archivePath, archive);
  execFileSync('tar', ['-xf', archivePath, '-C', tree]);
  await fs.cp(path.join(source, 'node_modules'), path.join(tree, 'node_modules'), { recursive: true, mode: constants.COPYFILE_FICLONE, verbatimSymlinks: true });
  if (identity.referenceCommit && identity.referenceCommit !== sourceCommit) throw Error('Receipt reference commit differs from archived source');
  const patchSha256 = patch ? sha(patch) : null;
  if (identity.patchSha256 !== undefined && identity.patchSha256 !== patchSha256) throw Error('Receipt patch differs from actual source patch');
  const touched = [...patch.matchAll(/^\+\+\+ b\/(.+)$/gm)].map(match => match[1]);
  if (patch && !touched.length) throw Error('Expected a unified source patch');
  for (const file of touched) {
    if (path.isAbsolute(file) || file.split('/').some(part => ['..', '.git', 'node_modules', 'planning'].includes(part))) throw Error(`Unsafe source patch ${file}`);
    let parent = path.dirname(path.join(tree, file));
    while (true) {
      try { if (!inside(tree, await fs.realpath(parent))) throw Error('Patch parent resolves outside scratch'); break; }
      catch (error) { if (error.code !== 'ENOENT') throw error; parent = path.dirname(parent); }
    }
    try { if (!inside(tree, await fs.realpath(path.join(tree, file)))) throw Error('Patch destination resolves outside scratch'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  if (patch) {
    const patchPath = path.join(directory, 'mutation.patch');
    await fs.writeFile(patchPath, patch);
    execFileSync('git', ['apply', '--check', patchPath], { cwd: tree, env: cleanEnv(), stdio: 'inherit' });
    execFileSync('git', ['apply', patchPath], { cwd: tree, env: cleanEnv(), stdio: 'inherit' });
  }
  const record = { ...identity, sourceCommit, patchSha256 };
  const config = path.join(directory, 'vite.config.mjs');
  await fs.writeFile(config, `import original from ${JSON.stringify(path.join(tree, 'vite.config.ts'))};
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
export default {
  ...original, root: ${JSON.stringify(tree)}, cacheDir: ${JSON.stringify(path.join(directory, 'vite-cache'))},
  build: { ...original.build, outDir: ${JSON.stringify(outDir)}, emptyOutDir: true },
  plugins: [...original.plugins, { name: 'reference-artifact-receipt', writeBundle(options, bundle) {
    const entry = Object.values(bundle).find(item => item.type === 'chunk' && item.isEntry && item.facadeModuleId === ${JSON.stringify(path.join(tree, 'index.html'))});
    if (!entry) throw new Error('Build has no app entry');
    const bodies = Object.values(bundle).filter(item => /\\.m?js$/.test(item.fileName)).map(item => [item.fileName, readFileSync(resolve(options.dir, item.fileName))]);
    const scripts = Object.fromEntries(bodies.map(([file, body]) => [file, sha(body)]));
    const markerCounts = Object.fromEntries(${JSON.stringify(markerSpecs)}.map(spec => [spec.name, Object.fromEntries(bodies.map(([file, body]) => {
      const text = body.toString('utf8');
      const count = spec.pattern ? [...text.matchAll(new RegExp(spec.pattern, 'g'))].length : text.split(spec.find).length - 1;
      return [file, count];
    }).filter(([, count]) => count > 0))]));
    writeFileSync(resolve(options.dir, ${JSON.stringify(receiptName)}), JSON.stringify({ ...${JSON.stringify(record)}, entry: entry.fileName, scripts, markerCounts }));
  } }],
};
`);
  await command(path.join(tree, 'node_modules/.bin/vite'), ['build', '--config', config], { cwd: tree });
  const manifest = { ...record, directory, tree, outDir, config, receipt: path.join(outDir, receiptName), serving: false };
  await fs.writeFile(path.join(directory, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  console.log(JSON.stringify(manifest));
}
if (process.argv[1] && path.resolve(process.argv[1]) === modulePath && process.argv[2] === '--job') await perform(process.argv[3]);
