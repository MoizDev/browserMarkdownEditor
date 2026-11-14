import { mkdir, open, readFile, unlink, appendFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const exec = promisify(execFile);
export const scratch = process.env.BME_SCRATCH ?? '/Users/adham/Developer/bme-impl/scratch';
export const lockRoot = process.env.BME_LOCK_DIR ?? join(scratch, 'locks');
const lockPath = join(lockRoot, 'bench.lock');
export async function lockState() {
    return JSON.parse(await readFile(join(lockRoot, 'state.json'), 'utf8'));
}
function alive(pid) {
    if (!Number.isSafeInteger(pid) || pid < 1) return false;
    try { process.kill(pid, 0); return true; } catch (error) { return error.code !== 'ESRCH'; }
}
async function ancestors() {
    const result = new Set([process.pid]);
    let pid = process.ppid;
    while (pid > 1 && !result.has(pid)) {
        result.add(pid);
        const { stdout } = await exec('/bin/ps', ['-o', 'ppid=', '-p', String(pid)]);
        pid = Number(stdout.trim());
    }
    return result;
}
export async function assertGrant(mode) {
    const state = await lockState(), parents = await ancestors();
    const cls = mode === 'accepted' ? 'bench' : 'run';
    const grant = state.holders.find(h => h.cls === cls && parents.has(h.pid) && alive(h.pid));
    if (!grant) throw new Error(`Run this script through bme-lock ${cls}; no ancestor holds that grant`);
    if (mode === 'accepted') {
        if (!state.window) throw new Error('Accepted timing requires an integrator-declared window');
        const others = state.holders.filter(h => h.id !== grant.id && alive(h.pid));
        if (others.length) throw new Error(`Timing window still has other holders: ${JSON.stringify(others)}`);
        // The integrator's current state has a time-of-day, not an expiry timestamp.
        // Refuse expired grants too; crossing midnight is handled as the preceding day.
        const [hours, minutes, seconds] = state.window.since.split(':').map(Number);
        const start = new Date(); start.setHours(hours, minutes, seconds, 0);
        if (start.getTime() > Date.now()) start.setDate(start.getDate() - 1);
        if (!(Date.now() - start.getTime() < state.window.minutes * 60_000)) throw new Error('Timing window expired');
    }
    return { grant, window: state.window };
}
export async function reclaimBenchLock(token, cause) {
    if (!token || !cause) throw new Error('Reclaim requires the exact token and a recorded cause');
    const guardPath = join(lockRoot, 'bench.reclaim.lock');
    // Serialize explicit reclaimers: read/token-check/unlink alone would let a
    // second reclaimer unlink a fresh holder after the first removes the stale one.
    const guard = await open(guardPath, 'wx', 0o600);
    try {
        await guard.writeFile(JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));
        const previous = JSON.parse(await readFile(lockPath, 'utf8'));
        if (previous.token !== token) throw new Error('Reclaim token mismatch; nothing removed');
        if (alive(previous.pid)) throw new Error('Holder PID is still alive; nothing removed');
        const reportPath = join(scratch, 'v-c/reports/lock-recoveries.jsonl');
        await mkdir(dirname(reportPath), { recursive: true });
        await appendFile(reportPath, JSON.stringify({ at: new Date().toISOString(), pid: previous.pid,
            token, cause, previous, action: 'verified-dead-token-reclaim' }) + '\n');
        await unlink(lockPath);
        return { reportPath, pid: previous.pid, token };
    } finally { await guard.close(); await unlink(guardPath); }
}
export async function acquireBenchLock(mode) {
    const grant = await assertGrant(mode);
    await mkdir(dirname(lockPath), { recursive: true });
    const holder = { pid: process.pid, parentPid: process.ppid, holder: process.env.HC_TERMINAL_ID ?? 'unknown',
        started: new Date().toISOString(), token: randomUUID(), mode, grant };
    let fd;
    try { fd = await open(lockPath, 'wx', 0o600); }
    catch (error) {
        if (error.code !== 'EEXIST') throw error;
        let previous;
        try { previous = JSON.parse(await readFile(lockPath, 'utf8')); }
        catch { throw new Error(`Unreadable/partially written lock ${lockPath}; refuse to steal it`); }
        // A dead PID is stale, not free. Automatic read/unlink/recreate permits two
        // reclaimers to unlink a new holder's lock. Refuse and request manual recovery.
        throw new Error(`${alive(previous.pid) ? 'Held' : 'STALE (dead PID; use explicit token-checked v-c reclaim)'}: ${lockPath}: ${JSON.stringify(previous)}`);
    }
    try { await fd.writeFile(JSON.stringify(holder, null, 2)); await fd.sync(); }
    catch (error) { await fd.close(); await unlink(lockPath); throw error; }
    await fd.close();
    return { holder, async assertHeld() {
        try {
            const current = JSON.parse(await readFile(lockPath, 'utf8'));
            if (current.token !== holder.token) throw new Error('Benchmark lock ownership changed');
            const currentGrant = await assertGrant(mode);
            if (mode === 'accepted' && JSON.stringify(currentGrant.window) !== JSON.stringify(grant.window)) {
                throw new Error('Timing window changed mid-run');
            }
        } catch (error) {
            error.invalidCause = `machine grant/window invalid: ${error.message}`; throw error;
        }
    }, async release() {
        const current = JSON.parse(await readFile(lockPath, 'utf8'));
        if (current.token !== holder.token) throw new Error('Refusing to release another benchmark holder');
        await unlink(lockPath);
    } };
}
