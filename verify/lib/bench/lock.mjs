import { mkdir, open, readFile, unlink, appendFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { scratchRoot } from '../paths.mjs';
export const scratch = scratchRoot;
export const lockRoot = join(scratch, 'locks');
const lockPath = join(lockRoot, 'bench.lock');
function alive(pid) {
    if (!Number.isSafeInteger(pid) || pid < 1) return false;
    try { process.kill(pid, 0); return true; } catch (error) { return error.code !== 'ESRCH'; }
}
// An accepted timing is only as good as the quiet machine under it, and only the person running
// it can promise that: they declare how long the machine stays otherwise idle, from the moment
// the run starts. Fixed once per process, so every check compares against the same window.
let declaredWindow;
function timingWindow() {
    if (declaredWindow) return declaredWindow;
    const minutes = Number(process.env.BME_BENCH_WINDOW_MINUTES);
    if (!(minutes > 0)) throw new Error('Accepted timing needs a declared quiet window: set BME_BENCH_WINDOW_MINUTES to how many minutes this machine will run nothing else');
    declaredWindow = { since: new Date().toTimeString().slice(0, 8), minutes };
    return declaredWindow;
}
export async function assertGrant(mode) {
    const cls = mode === 'accepted' ? 'bench' : 'run';
    const window = mode === 'accepted' ? timingWindow() : null;
    if (window) {
        // The window has a time-of-day, not an expiry timestamp; crossing midnight is the preceding day.
        const [hours, minutes, seconds] = window.since.split(':').map(Number);
        const start = new Date(); start.setHours(hours, minutes, seconds, 0);
        if (start.getTime() > Date.now()) start.setDate(start.getDate() - 1);
        if (!(Date.now() - start.getTime() < window.minutes * 60_000)) throw new Error('Timing window expired');
    }
    return { grant: { pid: process.pid, cls }, window };
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
    const holder = { pid: process.pid, parentPid: process.ppid,
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
        throw new Error(`${alive(previous.pid) ? 'Held' : 'STALE (dead PID; reclaim it with `node verify/bench/v-c.mjs reclaim <token> <cause>`)'}: ${lockPath}: ${JSON.stringify(previous)}`);
    }
    try { await fd.writeFile(JSON.stringify(holder, null, 2)); await fd.sync(); }
    catch (error) { await fd.close(); await unlink(lockPath); throw error; }
    await fd.close();
    // Inherited by child processes too: the functional-only target observer refuses a timed run.
    process.env.BME_TIMED_RUN = holder.token;
    return { holder, async assertHeld() {
        try {
            const current = JSON.parse(await readFile(lockPath, 'utf8'));
            if (current.token !== holder.token) throw new Error('Benchmark lock ownership changed');
            const currentGrant = await assertGrant(mode);
            if (mode === 'accepted' && JSON.stringify(currentGrant.window) !== JSON.stringify(grant.window)) {
                throw new Error('Timing window changed mid-run');
            }
        } catch (error) {
            error.invalidCause = `bench lock/window invalid: ${error.message}`; throw error;
        }
    }, async release() {
        const current = JSON.parse(await readFile(lockPath, 'utf8'));
        if (current.token !== holder.token) throw new Error('Refusing to release another benchmark holder');
        await unlink(lockPath);
        delete process.env.BME_TIMED_RUN;
    } };
}
