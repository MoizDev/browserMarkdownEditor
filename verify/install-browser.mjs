// Installs the one browser every headless run uses: Chrome for Testing at the version in
// browser-pin.json, for this machine's platform, into the per-user cache (`browserCache()`).
// Launched by path because installed Chrome updates itself mid-run and Playwright's bundled
// Chromium crashed reading a stored folder handle (verify-in-browser). Usage:
//   node verify/install-browser.mjs        (again: a no-op that prints the path)
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { access, mkdir, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { browserCache, chromePlatform, pin } from './lib/paths.mjs';

const platform = chromePlatform();
const entry = pin.platforms[platform];
const target = join(browserCache(), pin.version);
const executable = join(target, entry.executable);
const exists = path => access(path).then(() => true, () => false);

if (await exists(executable)) {
    console.log(executable);
    process.exit(0);
}
const folder = entry.executable.split('/')[0];
if (await exists(join(target, folder))) throw new Error(`${join(target, folder)} exists but holds no ${entry.executable}; remove it and run again`);

await mkdir(browserCache(), { recursive: true });
// Staged beside the target and renamed in at the end, so an interrupted download or unpack never
// leaves a half browser where the next run would find and launch it.
const staging = join(browserCache(), `.staging-${platform}-${process.pid}`);
const archive = `${staging}.zip`;
try {
    console.error(`Downloading Chrome for Testing ${pin.version} (${platform}, ${(entry.bytes / 1e6).toFixed(0)} MB)`);
    const response = await fetch(entry.url);
    if (!response.ok || !response.body) throw new Error(`Download failed: HTTP ${response.status} ${entry.url}`);
    const hash = createHash('sha256');
    let bytes = 0;
    const counted = Readable.fromWeb(response.body);
    counted.on('data', chunk => { hash.update(chunk); bytes += chunk.length; });
    await pipeline(counted, createWriteStream(archive));
    const sha256 = hash.digest('hex');
    if (bytes !== entry.bytes || sha256 !== entry.sha256) {
        throw new Error(`Downloaded archive does not match the pin: ${bytes} bytes sha256 ${sha256}; expected ${entry.bytes} bytes sha256 ${entry.sha256}`);
    }
    await mkdir(staging);
    // ditto keeps the macOS app bundle's symlinks and attributes; Windows 10+ ships bsdtar.
    const [command, ...args] = process.platform === 'darwin' ? ['ditto', '-x', '-k', archive, staging]
        : process.platform === 'win32' ? ['tar', '-xf', archive, '-C', staging]
            : ['unzip', '-q', archive, '-d', staging];
    const code = await new Promise((resolve, reject) => {
        const child = spawn(command, args, { stdio: 'inherit' });
        child.once('error', error => reject(new Error(`Cannot run ${command} to unpack the archive: ${error.message}`)));
        child.once('exit', resolve);
    });
    if (code !== 0) throw new Error(`${command} exited with ${code} unpacking ${archive}`);
    if (!await exists(join(staging, entry.executable))) throw new Error(`The archive holds no ${entry.executable}`);
    await mkdir(target, { recursive: true });
    await rename(join(staging, folder), join(target, folder));
    console.log(executable);
} finally {
    await rm(archive, { force: true });
    await rm(staging, { recursive: true, force: true });
}
