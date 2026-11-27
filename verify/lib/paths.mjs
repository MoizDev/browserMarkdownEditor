import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { access } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const sourceRoot = resolve(fileURLToPath(new URL('../../', import.meta.url)));
export const pin = JSON.parse(readFileSync(new URL('../browser-pin.json', import.meta.url), 'utf8'));
export const installCommand = 'node verify/install-browser.mjs';

export const scratchRoot = resolve(process.env.BME_SCRATCH
    ?? join(tmpdir(), `bme-verify-${basename(sourceRoot)}-${createHash('sha256').update(sourceRoot).digest('hex').slice(0, 8)}`));
export const scratchDir = (...parts) => join(scratchRoot, ...parts);

export function browserCache() {
    if (process.env.BME_BROWSER_CACHE) return resolve(process.env.BME_BROWSER_CACHE);
    const base = process.platform === 'darwin' ? join(homedir(), 'Library', 'Caches')
        : process.platform === 'win32' ? (process.env.LOCALAPPDATA ?? tmpdir())
            : (process.env.XDG_CACHE_HOME ?? join(homedir(), '.cache'));
    return join(base, 'bme-verify', 'browsers');
}

export function chromePlatform() {
    const name = { 'darwin-arm64': 'mac-arm64', 'darwin-x64': 'mac-x64', 'linux-x64': 'linux64', 'win32-x64': 'win64' }[`${process.platform}-${process.arch}`];
    if (!name || !pin.platforms[name]) throw new Error(`Chrome for Testing ${pin.version} is not pinned for ${process.platform}-${process.arch}; pinned: ${Object.keys(pin.platforms).join(', ')}`);
    return name;
}

export function pinnedChromePath() {
    return process.env.BME_CHROME_PATH ? resolve(process.env.BME_CHROME_PATH)
        : join(browserCache(), pin.version, pin.platforms[chromePlatform()].executable);
}

export async function pinnedChrome() {
    const path = pinnedChromePath();
    try { await access(path); }
    catch {
        throw new Error(process.env.BME_CHROME_PATH
            ? `BME_CHROME_PATH names no file: ${path}`
            : `Chrome for Testing ${pin.version} is not installed at ${path}; run \`${installCommand}\` first`);
    }
    return path;
}

export function requiredInput(variable, what, value = process.env[variable]) {
    if (!value) throw new Error(`Set ${variable} to ${what}; it is not part of the repo.`);
    return resolve(value);
}
