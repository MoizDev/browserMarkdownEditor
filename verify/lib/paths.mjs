// Where a browser run finds the pinned browser and keeps what it generates. Everything here is
// derived from the clone itself, the OS and documented environment variables, so a fresh clone on
// any contributor's machine runs the same scripts with no setup beyond `npm ci` and the installer.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { access } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const sourceRoot = resolve(fileURLToPath(new URL('../../', import.meta.url)));
export const pin = JSON.parse(readFileSync(new URL('../browser-pin.json', import.meta.url), 'utf8'));
export const installCommand = 'node verify/install-browser.mjs';

/** Generated files never land in the clone (Vite's outDir must sit outside the source root, and
 * a stray build or screenshot would show up in `git status`). Keyed by the clone's path, so two
 * worktrees on one machine never share or overwrite each other's builds. `BME_SCRATCH` moves it. */
export const scratchRoot = resolve(process.env.BME_SCRATCH
    ?? join(tmpdir(), `bme-verify-${basename(sourceRoot)}-${createHash('sha256').update(sourceRoot).digest('hex').slice(0, 8)}`));
export const scratchDir = (...parts) => join(scratchRoot, ...parts);

/** A per-user cache outside every clone: the ~200MB browser is downloaded once per machine, not
 * once per worktree. `BME_BROWSER_CACHE` names the folder that holds `<version>/`. */
export function browserCache() {
    if (process.env.BME_BROWSER_CACHE) return resolve(process.env.BME_BROWSER_CACHE);
    const base = process.platform === 'darwin' ? join(homedir(), 'Library', 'Caches')
        : process.platform === 'win32' ? (process.env.LOCALAPPDATA ?? tmpdir())
            : (process.env.XDG_CACHE_HOME ?? join(homedir(), '.cache'));
    return join(base, 'bme-verify', 'browsers');
}

/** Chrome for Testing's own platform names (its download URLs use them). */
export function chromePlatform() {
    const name = { 'darwin-arm64': 'mac-arm64', 'darwin-x64': 'mac-x64', 'linux-x64': 'linux64', 'win32-x64': 'win64' }[`${process.platform}-${process.arch}`];
    if (!name || !pin.platforms[name]) throw new Error(`Chrome for Testing ${pin.version} is not pinned for ${process.platform}-${process.arch}; pinned: ${Object.keys(pin.platforms).join(', ')}`);
    return name;
}

/** The executable a run launches; `BME_CHROME_PATH` overrides (both pins are still checked at launch). */
export function pinnedChromePath() {
    return process.env.BME_CHROME_PATH ? resolve(process.env.BME_CHROME_PATH)
        : join(browserCache(), pin.version, pin.platforms[chromePlatform()].executable);
}

/** The pinned executable, or one sentence naming the command that gets it. */
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

/** Material a kit needs that is not in the repo (a corpus, an upstream fixture, a reference
 * worktree): taken from a named variable, or one clear sentence saying what to provide. A silent
 * skip would read as a pass. */
export function requiredInput(variable, what, value = process.env[variable]) {
    if (!value) throw new Error(`Set ${variable} to ${what}; it is not part of the repo.`);
    return resolve(value);
}
