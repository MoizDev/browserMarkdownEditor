// Whole-chunk boot faults only (not role/guard logic). The source build stays
// untouched; shared identity binds the actual separately served fault bytes.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { buildIdentity, toolboxIdentity } from './toolbox.mjs';
const [baseIdentityPath, baseDist, destination, fault] = process.argv.slice(2);
const bodies = { 'worker-boot-throw': 'throw new Error("P09 whole-chunk worker boot fault")', 'worker-boot-stall': 'self.onmessage = () => {}' };
if (!destination || !Object.hasOwn(bodies, fault)) throw new Error('Usage: boot-fault.mjs BASE_IDENTITY BASE_DIST NEW_SCRATCH_ROOT worker-boot-throw|worker-boot-stall');
const root = fileURLToPath(new URL('../../../', import.meta.url));
const base = JSON.parse(await readFile(baseIdentityPath));
if (!base.shared?.files?.length || base.mutant || base.faultProfile) throw new Error('A boot fault requires an identified clean source build');
const workers = base.shared.files.filter(file => /^assets\/pdfBuild\.worker-.*\.js$/.test(file.path));
if (workers.length !== 1) throw new Error('Expected one emitted role worker');
const worker = workers[0], sha = bytes => createHash('sha256').update(bytes).digest('hex');
const original = await readFile(path.join(baseDist, worker.path));
if (sha(original) !== worker.sha256) throw new Error('Base role-worker bytes changed');
await mkdir(destination);
const dist = path.join(destination, 'dist');
execFileSync('/bin/cp', ['-cR', baseDist, dist]);
const body = Buffer.from(bodies[fault]);
await writeFile(path.join(dist, worker.path), body);
const faultProfile = { id: fault, url: `/${worker.path}`, originalSha256: worker.sha256, sha256: sha(body), bytes: body.length };
const shared = await buildIdentity({ worktree: root, distDir: dist, patch: faultProfile });
if (!shared.treeClean || shared.commit !== base.commit) throw new Error('Boot-fault source does not match the clean candidate commit');
const identity = { ...base, shared, toolbox: toolboxIdentity, faultProfile,
    artifacts: shared.files.filter(file => /\.(?:html|css|m?js|wasm)$/.test(file.path)).map(file => ({ url: `/${file.path}`, sha256: file.sha256, bytes: file.bytes })) };
await writeFile(path.join(destination, 'build.json'), `${JSON.stringify(identity, null, 2)}\n`);
await writeFile(path.join(destination, 'vite.config.mjs'), `import original from ${JSON.stringify(path.join(root, 'vite.config.ts'))};\nexport default { ...original, root: ${JSON.stringify(root)}, cacheDir: ${JSON.stringify(path.join(destination, 'vite-cache'))}, build: { ...original.build, outDir: ${JSON.stringify(dist)}, emptyOutDir: true } };\n`);
console.log(JSON.stringify({ faultProfile, identity: path.join(destination, 'build.json'), config: path.join(destination, 'vite.config.mjs') }));
