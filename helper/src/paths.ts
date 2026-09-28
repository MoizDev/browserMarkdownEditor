// Where the agents run. Every path the helper builds from a value that came
// over the WebSocket goes through here: the value is validated first, the
// result is resolved, and it must still sit under the folder it was meant for.

import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { isUuid } from '../../shared/vaultAgentProtocol.ts';

/** `~/.bme-agent-sessions` (Windows: `%USERPROFILE%\.bme-agent-sessions`). */
export function sessionsRootFor(home: string = homedir()): string {
    return join(home, '.bme-agent-sessions');
}

/** True when `child` is `parent` itself or somewhere below it (after resolving). */
export function isInside(parent: string, child: string): boolean {
    const rel = relative(resolve(parent), resolve(child));
    return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

export class BadRequest extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'BadRequest';
    }
}

/** One vault's working folder: `<root>/<vaultId>`. The id must be a UUID. */
export function vaultDir(sessionsRoot: string, vaultId: unknown): string {
    if (!isUuid(vaultId)) throw new BadRequest('vaultId must be a UUID');
    const dir = resolve(sessionsRoot, vaultId.toLowerCase());
    if (!isInside(sessionsRoot, dir) || dir === resolve(sessionsRoot)) throw new BadRequest('vaultId escapes the sessions folder');
    return dir;
}

/** Owner-only: the folder holds copies of the user's instructions and the pasted images. */
export function ensureDir(path: string): string {
    mkdirSync(path, { recursive: true, mode: 0o700 });
    return path;
}
