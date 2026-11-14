// Measurement only. No CPU/load bound or pass/invalid decision is defined here.
import os from 'node:os';
import { basename } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { registeredBenchEvidence } from './benchProcesses.mjs';
const exec = promisify(execFile);
const clock = () => Number(process.hrtime.bigint()) / 1e6;
function cpuMilliseconds(text) {
    const [day, time] = text.includes('-') ? text.split('-') : ['0', text];
    return (Number(day) * 86400 + time.split(':').reverse().reduce((sum, value, i) => sum + Number(value) * 60 ** i, 0)) * 1000;
}
export async function collectAgentRoots() {
    // hc ls intentionally has no PID; get supplies it. Keep only addresses,
    // agent kinds and PIDs, never agent argv/prompts or process command arguments.
    const listing = JSON.parse((await exec('hc', ['ls', '--json'], { maxBuffer: 4 * 1024 ** 2 })).stdout);
    const terminals = listing.terminals.filter(t => t.state === 'live' && /^t[a-z0-9]+$/.test(t.address)
        && ['pi', 'claude-code', 'codex'].includes(t.agent));
    const roots = [];
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(4, terminals.length) }, async () => {
        while (next < terminals.length) {
            const terminal = terminals[next++];
            const detail = JSON.parse((await exec('hc', ['get', terminal.address], { maxBuffer: 4 * 1024 ** 2 })).stdout);
            if (Number.isInteger(detail.pid)) roots.push({ address: terminal.address, agent: terminal.agent, pid: detail.pid });
        }
    }));
    return roots.sort((a, b) => a.pid - b.pid);
}
export function runtimeClass(comm) {
    const name = basename(comm);
    if (/(?:Chrome|Chromium)/i.test(name)) return 'other-browser';
    if (/qemu|colima|lima|docker|Virtualization|socket_vmnet/i.test(name)) return 'vm';
    if (/^(?:node|bun|deno|vite|tsc|eslint|esbuild|rollup|npm|npx|make|cmake|ninja|clang\+\+|clang|gcc|g\+\+|cc|cargo|rustc|python[\d.]*)(?:\s|$)/i.test(name)) return 'other-runtime/build/server';
    if (/mds|mdworker|contextstored|fseventsd/i.test(name)) return 'system-indexing/daemon';
    return null;
}
export async function sampleCPU(agentRoots, previousBench = new Map()) {
    const beforeMonotonicMs = clock();
    const beforeHostBusyMs = os.cpus().reduce((sum, cpu) => sum + cpu.times.user + cpu.times.nice + cpu.times.sys + cpu.times.irq, 0);
    const { stdout } = await exec('/bin/ps', ['-Ao', 'pid=,ppid=,pcpu=,rss=,time=,comm='], { maxBuffer: 4 * 1024 ** 2 });
    const processes = stdout.trim().split('\n').map(line => {
        const match = line.match(/^\s*(\d+)\s+(\d+)\s+([\d.]+)\s+(\d+)\s+(\S+)\s+(.+)$/);
        if (!match) throw new Error(`Unparseable ps measurement row: ${line}`);
        return { pid: Number(match[1]), ppid: Number(match[2]), pcpu: Number(match[3]), rssKiB: Number(match[4]),
            cpuMs: cpuMilliseconds(match[5]), comm: match[6] };
    });
    const registered = await registeredBenchEvidence(processes);
    const byPid = new Map(processes.map(p => [p.pid, p]));
    const agents = new Map(agentRoots.map(p => [p.pid, p]));
    const ancestor = (proc, predicate) => {
        const seen = new Set();
        let pid = proc.pid;
        while (byPid.has(pid) && !seen.has(pid)) {
            if (predicate(pid)) return pid;
            seen.add(pid); pid = byPid.get(pid).ppid;
        }
        return null;
    };
    for (const proc of processes) {
        const previous = previousBench.get(proc.pid);
        const crashpad = basename(proc.comm) === 'chrome_crashpad_handler';
        const bench = crashpad ? registered.has(proc.pid) : ancestor(proc, pid => pid === process.pid)
            || (previous?.comm === proc.comm && proc.cpuMs >= previous.cpuMs);
        if (registered.has(proc.pid)) proc.benchAssociation = registered.get(proc.pid);
        const agent = ancestor(proc, pid => agents.has(pid));
        // A real agent's root is labelled from hc. Another runtime/build/browser
        // never inherits an agent label merely because an agent launched it.
        proc.role = bench ? 'bench' : agents.has(proc.pid) ? `agent:${agents.get(proc.pid).agent}`
            : runtimeClass(proc.comm) ?? (agent ? `agent-tree:${agents.get(agent).agent}` : 'system/other');
    }
    const cpus = os.cpus();
    return { at: new Date().toISOString(), monotonicMs: clock(), beforeMonotonicMs, beforeHostBusyMs,
        load: os.loadavg(), cpuCount: cpus.length,
        hostBusyMs: cpus.reduce((sum, cpu) => sum + cpu.times.user + cpu.times.nice + cpu.times.sys + cpu.times.irq, 0),
        top: [...processes].sort((a, b) => b.pcpu - a.pcpu).slice(0, 25), agentRootPids: agentRoots.map(a => a.pid),
        bench: processes.filter(p => p.role === 'bench'), raw: stdout };
}
export async function startCPUMeasurement(agentRoots, inspect = null) {
    const first = await sampleCPU(agentRoots);
    const samples = [first];
    const environmentSamples = inspect ? [await inspect(first)] : [];
    const known = new Map(first.bench.map(p => [p.pid, p]));
    const maxima = new Map(first.bench.map(p => [p.pid, { startMs: p.cpuMs, maxMs: p.cpuMs, resolutionMs: 20 }]));
    let stopped = false, timer, pending = Promise.resolve(), samplingError;
    const observe = async sample => {
        samples.push(sample);
        for (const proc of sample.bench) {
            known.set(proc.pid, proc);
            const entry = maxima.get(proc.pid) ?? { startMs: 0, maxMs: 0, resolutionMs: 10 };
            entry.maxMs = Math.max(entry.maxMs, proc.cpuMs); maxima.set(proc.pid, entry);
        }
        if (inspect) environmentSamples.push(await inspect(sample));
    };
    const tick = () => {
        pending = sampleCPU(agentRoots, known).then(observe).catch(error => { samplingError = error.message; }).finally(() => {
            if (!stopped) timer = setTimeout(tick, 1000);
        });
    };
    timer = setTimeout(tick, 1000);
    return { async stop(measurement) {
        stopped = true; clearTimeout(timer); await pending;
        await observe(await sampleCPU(agentRoots, known));
        // CDP sampled these BEFORE the adapter closed its fresh Chrome. Recover
        // renderer/GPU CPU that ps can miss at exit; unseen work stays outside.
        for (const memory of [measurement?.memoryBefore, measurement?.memoryAfter]) {
            for (const proc of memory?.processes ?? []) {
                if (!Number.isFinite(proc.cpuTime)) continue;
                const cpuMs = proc.cpuTime * 1000;
                const entry = maxima.get(proc.id) ?? { startMs: 0, maxMs: 0, resolutionMs: 0.001 };
                if (cpuMs > entry.maxMs) { entry.maxMs = cpuMs; entry.resolutionMs = 0.001; }
                maxima.set(proc.id, entry);
            }
        }
        const last = samples.at(-1), elapsedMs = last.monotonicMs - first.beforeMonotonicMs;
        const benchMsLower = [...maxima.values()].reduce((sum, p) => sum + Math.max(0, p.maxMs - p.startMs - p.resolutionMs), 0);
        const hostBusyMs = Math.max(0, last.hostBusyMs - first.beforeHostBusyMs);
        return { samples, environmentSamples, samplingError, elapsedMs, hostBusyMs, benchMsLower,
            benchCpuByPid: Object.fromEntries(maxima),
            outsideBenchCores: Math.max(0, hostBusyMs - benchMsLower) / elapsedMs,
            outsideBenchPercent: Math.max(0, hostBusyMs - benchMsLower) / elapsedMs * 100,
            accounting: 'Host non-idle CPU-time delta minus observed runner PID tree (browser, inline server, sampler). Agents/daemons remain outside. Missed exits and timer quantization can overestimate outside CPU. Measurement ONLY, no preflight cutoff.' };
    } };
}
