import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

/** Grants are held by the supervising bme-lock process, not its Node child.
 * Inspect ancestry so a shell wrapper cannot hide a run/bench grant (HOWTO §1).
 * @returns {Promise<Set<string>>}
 */
export async function currentGrants() {
    const state = JSON.parse(await readFile(join(process.env.BME_LOCK_DIR ?? '/Users/adham/Developer/bme-impl/scratch/locks', 'state.json'), 'utf8'));
    const ancestors = new Set();
    let pid = process.pid;
    for (let depth = 0; pid > 0 && depth < 64; depth++) {
        ancestors.add(pid);
        const parent = Number(execFileSync('/bin/ps', ['-o', 'ppid=', '-p', String(pid)], { encoding: 'utf8' }).trim());
        if (!parent || parent === pid) break;
        pid = parent;
    }
    return new Set(state.holders.filter(holder => ancestors.has(holder.pid)).map(holder => holder.cls));
}
