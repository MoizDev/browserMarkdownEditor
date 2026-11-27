// Where the agents run. Every path the helper builds from a value that came
// over the WebSocket goes through here: the value is validated first, the
// result is resolved, and it must still sit under the folder it was meant for.

import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { isUuid } from '../../shared/vaultAgentProtocol.ts';

export function sessionsRootFor(home: string = homedir()): string {
    return join(home, '.bme-agent-sessions');
}

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

export function vaultDir(sessionsRoot: string, vaultId: unknown): string {
    if (!isUuid(vaultId)) throw new BadRequest('vaultId must be a UUID');
    const dir = resolve(sessionsRoot, vaultId.toLowerCase());
    if (!isInside(sessionsRoot, dir) || dir === resolve(sessionsRoot)) throw new BadRequest('vaultId escapes the sessions folder');
    return dir;
}

export function ensureDir(path: string): string {
    mkdirSync(path, { recursive: true, mode: 0o700 });
    return path;
}
