import { createHash } from 'node:crypto';
import { spawn, execFile } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { PINS } from './pins.mjs';
import { isolatedDockerEnv } from './docker.mjs';

const ROOT = resolve(fileURLToPath(new URL('../../', import.meta.url)));
const execute = promisify(execFile);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
if (process.argv.length !== 4 || process.argv[2] !== '--context') throw new Error('Usage (through bme-vm only): node verify/image/build.mjs --context <prepared external context>');
const context = resolve(process.argv[3]);
if (context === ROOT || context.startsWith(`${ROOT}/`)) throw new Error('Build context must be external scratch');
const proposal = JSON.parse(await readFile(resolve(context, 'IMAGE.proposal.json'), 'utf8'));
if (proposal.base !== PINS.base || proposal.browser.sha256 !== PINS.browser.sha256 || proposal.platform !== 'linux/amd64') throw new Error('Image proposal does not match the reviewed pins');
if (hash(await readFile(resolve(context, 'Dockerfile'))) !== proposal.dockerfileSha256 || hash(await readFile(resolve(context, 'fonts.conf'))) !== proposal.fontconfigSha256 || hash(await readFile(resolve(context, 'fonts.manifest.json'))) !== proposal.fontManifestSha256) throw new Error('Prepared image inputs changed');
if (hash(await readFile(resolve(ROOT, 'verify/image/Dockerfile'))) !== proposal.dockerfileSha256 || hash(await readFile(resolve(ROOT, 'verify/image/fonts.conf'))) !== proposal.fontconfigSha256) throw new Error('Image sources changed after preparation; prepare a fresh context');

const env = await isolatedDockerEnv(resolve(context, '..'));
const iidFile = resolve(context, 'image-id');
await new Promise((accept, reject) => {
    const child = spawn('docker', ['buildx', 'build', '--builder', 'default', '--load', '--platform', 'linux/amd64', '--iidfile', iidFile, context], { env, stdio: 'inherit' });
    child.once('error', reject);
    child.once('exit', (code, signal) => code === 0 ? accept() : reject(new Error(`Local image build failed: ${code ?? signal}`)));
});
const imageId = (await readFile(iidFile, 'utf8')).trim();
if (!/^sha256:[a-f0-9]{64}$/.test(imageId)) throw new Error('Docker returned an invalid local image ID');
const { stdout: inspected } = await execute('docker', ['image', 'inspect', imageId], { env });
const inspectedImage = JSON.parse(inspected)[0];
if (inspectedImage.Id !== imageId || inspectedImage.Architecture !== 'amd64' || inspectedImage.Os !== 'linux') throw new Error('Built image identity/platform did not resolve locally');
const inventoryProgram = `const fs=require('node:fs'); console.log(JSON.stringify({fontconfig:fs.readFileSync('/opt/fonts/fontconfig-list.txt','utf8'),libraries:fs.readFileSync('/opt/picture/library-packages.txt','utf8'),archives:fs.readFileSync('/opt/picture/library-archives.sha256','utf8')}));`;
const { stdout } = await execute('docker', ['run', '--rm', '--platform', 'linux/amd64', '--network', 'none', '--entrypoint', 'node', imageId, '-e', inventoryProgram], { env, maxBuffer: 4 * 1024 * 1024 });
const inventory = JSON.parse(stdout);
const lock = { ...proposal, imageId, imageDigestKind: 'Local Docker image config/content ID; not a registry tag or pushed digest', builtAt: new Date().toISOString(), fontconfigInventory: inventory.fontconfig, libraryInventory: inventory.libraries, libraryArchives: inventory.archives };
const lockPath = resolve(ROOT, 'verify/image/IMAGE.lock');
try {
    await writeFile(lockPath, `${JSON.stringify(lock, null, 2)}\n`, { flag: 'wx' });
} catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const previous = JSON.parse(await readFile(lockPath, 'utf8'));
    if (previous.imageId !== imageId) {
        await writeFile(resolve(context, 'IMAGE.changed.json'), `${JSON.stringify(lock, null, 2)}\n`, { flag: 'wx' });
        throw new Error('The image changed. Proposal saved, locked image NOT updated: review the new environment and every affected golden first');
    }
}
process.stdout.write(`${JSON.stringify({ imageId, browserSha256: proposal.browser.sha256, fonts: proposal.fonts.length, lock: lockPath })}\n`);
