import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const exec = promisify(execFile);
const GiB = 1024 ** 3;
async function command(file, args = []) {
    try { const { stdout, stderr } = await exec(file, args, { timeout: 10_000 }); return { stdout, stderr }; }
    catch (error) { return { error: error.message, stdout: error.stdout ?? '', stderr: error.stderr ?? '' }; }
}
export async function machineIdentity() {
    return { os: { platform: os.platform(), release: os.release(), version: os.version(), arch: os.arch() },
        hardware: { cpus: os.cpus().map(({ model, speed }) => ({ model, speed })), totalBytes: os.totalmem(),
            sysctl: await command('/usr/sbin/sysctl', ['hw.model', 'hw.memsize', 'hw.physicalcpu', 'hw.logicalcpu']) },
        display: await command('/usr/sbin/system_profiler', ['SPDisplaysDataType', '-json']) };
}
export async function machineSnapshot() {
    const [vm, power, thermal] = await Promise.all([
        command('/usr/bin/vm_stat'), command('/usr/bin/pmset', ['-g', 'batt']), command('/usr/bin/pmset', ['-g', 'therm']),
    ]);
    const pageBytes = Number(vm.stdout.match(/page size of (\d+) bytes/)?.[1]);
    const field = name => {
        const value = vm.stdout.match(new RegExp(`^${name}:\\s+(\\d+)\\.?$`, 'm'))?.[1];
        return value === undefined ? null : Number(value);
    };
    const free = field('Pages free'), inactive = field('Pages inactive'), purgeable = field('Pages purgeable');
    return { at: new Date().toISOString(), load: os.loadavg(),
        freeBytes: pageBytes && [free, inactive, purgeable].every(x => x !== null) ? (free + inactive + purgeable) * pageBytes : null,
        pageBytes, pages: { free, inactive, purgeable, pageins: field('Pageins'), swapins: field('Swapins') },
        powerSource: /'AC Power'/.test(power.stdout) ? 'AC' : /'Battery Power'/.test(power.stdout) ? 'battery' : 'unknown',
        throttled: /(?:CPU_Speed_Limit|Scheduler_Limit|CPU_Scheduler_Limit)\s*=\s*(?:[0-9]|[1-9][0-9])\b/.test(thermal.stdout)
            || /(?:Thermal_Level|ThermalPressure)\s*=\s*[1-9]/.test(thermal.stdout),
        raw: { vm, power, thermal } };
}
export function sessionValidity(before, after, { memoryFloorBytes = 6 * GiB, maxLoad = 2 } = {}) {
    const causes = [];
    for (const [phase, sample] of [['before', before], ['after', after]]) {
        if (sample.freeBytes === null) causes.push(`${phase}: free memory unreadable`);
        else if (sample.freeBytes < memoryFloorBytes) causes.push(`${phase}: free+inactive+purgeable below ${memoryFloorBytes} bytes`);
        if (sample.load[0] > maxLoad) causes.push(`${phase}: one-minute load ${sample.load[0]} > ${maxLoad}`);
        if (sample.powerSource !== 'AC') causes.push(`${phase}: power source ${sample.powerSource} (AC required)`);
        if (sample.throttled) causes.push(`${phase}: thermal/CPU throttling reported`);
        if (sample.pages.swapins === null) causes.push(`${phase}: swap-in counter unreadable`);
    }
    const swapins = before.pages.swapins === null || after.pages.swapins === null ? null : after.pages.swapins - before.pages.swapins;
    if (swapins !== null && swapins !== 0) causes.push(`swap-in counter delta ${swapins} (must be zero)`);
    return { valid: causes.length === 0, causes, swapins,
        pageins: before.pages.pageins === null || after.pages.pageins === null ? null : after.pages.pageins - before.pages.pageins,
        memoryFloorBytes, maxLoad };
}
export async function processMemory(browserCDP) {
    const { processInfo } = await browserCDP.send('SystemInfo.getProcessInfo');
    const relevant = processInfo.filter(p => ['renderer', 'GPU'].includes(p.type));
    if (!relevant.length) throw new Error('CDP reported no renderer/GPU processes');
    const result = await command('/bin/ps', ['-o', 'pid=,rss=', '-p', relevant.map(p => p.id).join(',')]);
    if (result.error) throw new Error(result.error);
    const rss = new Map(result.stdout.trim().split('\n').map(line => line.trim().split(/\s+/).map(Number)));
    return { at: new Date().toISOString(), processes: relevant.map(p => ({ ...p, rssBytes: (rss.get(p.id) ?? 0) * 1024 })), raw: result };
}
