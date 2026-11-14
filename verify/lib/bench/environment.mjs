// Process/lid/VM evidence for timing-window-bound.md §4. No CPU-percentage cutoff.
import { access } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { lockState, scratch } from './lock.mjs';
import { sampleCPU, runtimeClass } from './cpuMeasurement.mjs';
const exec = promisify(execFile);
const runRoots = [dirname(scratch), '/Users/adham/Developer/browserMarkdownEditor'];
const underRun = path => runRoots.some(root => path === root || path.startsWith(`${root}/`));
function parseProcesses(raw) {
    return raw.trim().split('\n').map(line => {
        const m = line.match(/^\s*(\d+)\s+(\d+)\s+([\d.]+)\s+(\d+)\s+(\S+)\s+(.+)$/);
        if (!m) throw new Error('Unparseable process ownership snapshot');
        return { pid: Number(m[1]), ppid: Number(m[2]), pcpu: Number(m[3]), comm: m[6] };
    });
}
export async function inspectProcessOwnership(cpu, grantPid) {
    const all = parseProcesses(cpu.raw), byPid = new Map(all.map(p => [p.pid, p]));
    const bench = new Set(cpu.bench.map(p => p.pid));
    const state = await lockState();
    const others = state.holders.filter(h => h.pid !== grantPid && byPid.has(h.pid));
    const othersByPid = new Set(others.map(h => h.pid));
    const fromOtherGrant = proc => {
        let pid = proc.pid;
        const seen = new Set();
        while (byPid.has(pid) && !seen.has(pid)) {
            if (othersByPid.has(pid)) return true;
            seen.add(pid); pid = byPid.get(pid).ppid;
        }
        return false;
    };
    const kinds = new Set(['other-browser', 'vm', 'other-runtime/build/server']);
    const agents = new Set(cpu.agentRootPids);
    const candidates = all.filter(p => p.pid !== grantPid && !bench.has(p.pid) && !agents.has(p.pid) && kinds.has(runtimeClass(p.comm)));
    const cwd = new Map(), hasRunArgument = new Set();
    if (candidates.length) {
        // comm alone cannot distinguish an IDE's node from a run's node. Keep
        // only CWD ownership and an argv root-match BOOLEAN; never persist argv,
        // which can contain private prompts, credentials or vault text.
        const { stdout } = await exec('/usr/sbin/lsof', ['-a', '-d', 'cwd', '-p', candidates.map(p => p.pid).join(','), '-Fpn'],
            { maxBuffer: 4 * 1024 ** 2 }).catch(error => ({ stdout: error.stdout ?? '' }));
        const argumentsOutput = await exec('/bin/ps', ['-ww', '-p', candidates.map(p => p.pid).join(','), '-o', 'pid=,args='],
            { maxBuffer: 4 * 1024 ** 2 }).catch(error => ({ stdout: error.stdout ?? '' }));
        for (const line of argumentsOutput.stdout.split('\n')) {
            const m = line.match(/^\s*(\d+)\s+(.*)$/);
            if (m && runRoots.some(root => m[2].includes(`${root}/`))) hasRunArgument.add(Number(m[1]));
        }
        let pid;
        for (const line of stdout.split('\n')) {
            if (line.startsWith('p')) pid = Number(line.slice(1));
            else if (line.startsWith('n') && pid) cwd.set(pid, line.slice(1));
        }
    }
    const runOwned = [], unverified = [], vmProcesses = [];
    for (const proc of candidates) {
        const kind = runtimeClass(proc.comm);
        if (kind === 'vm') vmProcesses.push(proc);
        const owned = underRun(proc.comm) || hasRunArgument.has(proc.pid) || fromOtherGrant(proc) || (cwd.has(proc.pid) && underRun(cwd.get(proc.pid)));
        if (owned) runOwned.push({ ...proc, kind, ownership: 'run executable/CWD, run-root argv match (arguments not retained), or authoritative run grant' });
        else if (!cwd.has(proc.pid)) unverified.push({ ...proc, kind, ownership: 'runtime CWD unavailable; cannot prove it is outside the run' });
    }
    let vmReadyMarker = false;
    try { await access(join(scratch, 'colima/bme.ready')); vmReadyMarker = true; }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    return { at: cpu.at, topConsumers: cpu.top, runOwned, unverified, vmProcesses, vmReadyMarker,
        otherGrants: others.map(({ pid, cls, who }) => ({ pid, cls, who })),
        vmDown: !vmReadyMarker && vmProcesses.length === 0 && !others.some(h => ['vm', 'vmuse'].includes(h.cls)),
        ownershipRule: 'Bench PID tree allowed. Agent CLIs identified separately; other runtime commands never inherit agent status. Owner/system runtimes outside run roots are not stopped or labelled run-owned.' };
}
export async function environmentSnapshot(agentRoots, grantPid) {
    const cpu = await sampleCPU(agentRoots);
    const ownership = await inspectProcessOwnership(cpu, grantPid);
    let lid;
    try {
        const { stdout } = await exec('/usr/sbin/ioreg', ['-r', '-k', 'AppleClamshellState', '-d', '4'], { maxBuffer: 4 * 1024 ** 2 });
        const lines = stdout.split('\n').filter(line => line.includes('"AppleClamshellState"'));
        lid = { open: lines.some(line => /="?\s*No\b/.test(line)) ? true : lines.some(line => /="?\s*Yes\b/.test(line)) ? false : null,
            raw: lines.join('\n') };
    } catch (error) { lid = { open: null, error: error.message }; }
    return { ...ownership, lid };
}
export function environmentCauses(environment, phase, checkLid = true) {
    if (!environment || environment.error) return [`${phase}: process/VM/lid preflight missing: ${environment?.error ?? 'no record'}`];
    const causes = [];
    if (environment.runOwned.length) causes.push(`${phase}: run-owned work present: ${environment.runOwned.map(p => `${p.pid} ${p.comm}`).join('; ')}`);
    if (environment.otherGrants.length) causes.push(`${phase}: other authoritative grants present: ${environment.otherGrants.map(p => `${p.pid}/${p.cls}`).join(', ')}`);
    if (environment.unverified.length) causes.push(`${phase}: runtime ownership unverified: ${environment.unverified.map(p => `${p.pid} ${p.comm}`).join('; ')}`);
    if (!environment.vmDown) causes.push(`${phase}: VM is not proven down`);
    if (checkLid && environment.lid?.open !== true) causes.push(`${phase}: lid closed or unreadable`);
    return causes;
}
