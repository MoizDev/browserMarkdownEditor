// Bind served bytes to the source snapshot on both sides of the production build.
import { readFile, writeFile, readdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildIdentity, toolboxIdentity } from './toolbox.mjs';
const repository = fileURLToPath(new URL('../../../', import.meta.url));
const sha = value => createHash('sha256').update(value).digest('hex');
const [mode, root, destination, identityPath] = process.argv.slice(2);
if (!['source', 'artifacts'].includes(mode) || !root || !destination) throw new Error('Usage: identity.mjs source ROOT IDENTITY_JSON | artifacts ROOT DIST IDENTITY_JSON');
async function walk(dir, prefix = '') {
  const result = [];
  for (const entry of (await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
    const file = prefix + entry.name;
    if (entry.isDirectory()) result.push(...await walk(path.join(dir, entry.name), `${file}/`));
    else if (entry.isFile()) result.push(file);
    else throw new Error(`Unregistered symbolic input: ${file}`);
  }
  return result;
}
async function sourceIdentity() {
  const names = ['index.html', 'package.json', 'package-lock.json', 'vite.config.ts', ...await walk(path.join(root, 'src'), 'src/'), ...await walk(path.join(root, 'shared'), 'shared/'), ...await walk(path.join(root, 'public'), 'public/')];
  try { await readFile(path.join(root, 'vite.config.mjs')); names.push('vite.config.mjs'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const files = [];
  for (const file of names.sort()) files.push({ file, sha256: sha(await readFile(path.join(root, file))) });
  return { sha256: sha(JSON.stringify(files)), files };
}
const source = await sourceIdentity();
if (!process.env.BUILD_CONFIG) throw new Error('BUILD_CONFIG must name the exact Vite config being built');
source.configSha256 = sha(await readFile(process.env.BUILD_CONFIG));
if (mode === 'source') {
  let mutant;
  try { mutant = JSON.parse(await readFile(path.join(root, 'patch-identity.json'))); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const commit = mutant?.commit ?? execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  await writeFile(destination, `${JSON.stringify({ schema: 1, commit, source, mutant: mutant ?? null }, null, 2)}\n`, { flag: 'wx' });
} else {
  if (!identityPath) throw new Error('artifacts requires a pre-build identity file');
  const identity = JSON.parse(await readFile(identityPath));
  if (identity.source.sha256 !== source.sha256 || identity.source.configSha256 !== source.configSha256) throw new Error('Build inputs moved during the build');
  const shared = await buildIdentity({ worktree: identity.mutant ? repository : root, distDir: destination, patch: identity.mutant ?? undefined });
  if (shared.commit !== identity.commit) throw new Error('Source commit moved during build');
  if (!shared.treeClean) throw new Error('The base product source must be committed before a candidate or source-mutant build');
  identity.shared = shared;
  identity.toolbox = toolboxIdentity;
  identity.artifacts = shared.files.filter(file => /\.(?:html|css|m?js|wasm)$/.test(file.path))
    .map(file => ({ url: `/${file.path}`, sha256: file.sha256, bytes: file.bytes }));
  const html = await readFile(path.join(destination, 'index.html'), 'utf8');
  identity.entry = html.match(/<script[^>]+src="([^"]+)"/)?.[1];
  if (!identity.entry || !identity.artifacts.some(file => file.url === identity.entry)) throw new Error('Built app entry is not in artifact inventory');
  await writeFile(identityPath, `${JSON.stringify(identity, null, 2)}\n`);
}
