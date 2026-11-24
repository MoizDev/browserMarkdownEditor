// CfT Crashpad deliberately reparents to PID1. Exact native birth time binds ONLY
// handlers born during this browser launch; current PPID alone cannot prove that.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { basename } from 'node:path';
const exec = promisify(execFile);
const registry = new Map();
const pendingLaunches = new Set();
export const epochMicroseconds = () => (performance.timeOrigin + performance.now()) * 1000;

// Darwin proc_bsdinfo (SDK sys/proc_info.h:59–82), not ps lstart's whole seconds.
// Python stdlib is an OS-API bridge here: no install, argv/prompt read, or self-test.
const nativeQuery = String.raw`import ctypes, json, sys
class BSD(ctypes.Structure):
    _fields_ = [(name, ctypes.c_uint32) for name in ['flags','status','xstatus','pid','ppid','uid','gid','ruid','rgid','svuid','svgid','reserved']] + [
        ('comm',ctypes.c_char*16),('name',ctypes.c_char*32),('nfiles',ctypes.c_uint32),('pgid',ctypes.c_uint32),
        ('jobc',ctypes.c_uint32),('tdev',ctypes.c_uint32),('tpgid',ctypes.c_uint32),('nice',ctypes.c_int32),
        ('start_sec',ctypes.c_uint64),('start_usec',ctypes.c_uint64)]
lib=ctypes.CDLL('/usr/lib/libproc.dylib',use_errno=True)
lib.proc_pidinfo.argtypes=[ctypes.c_int,ctypes.c_int,ctypes.c_uint64,ctypes.c_void_p,ctypes.c_int]
lib.proc_pidpath.argtypes=[ctypes.c_int,ctypes.c_void_p,ctypes.c_uint32]
rows=[]
for pid in json.loads(sys.argv[1]):
    info=BSD(); path=ctypes.create_string_buffer(4096)
    size=lib.proc_pidinfo(pid,3,0,ctypes.byref(info),ctypes.sizeof(info))
    length=lib.proc_pidpath(pid,path,len(path))
    if size != ctypes.sizeof(info) or info.pid != pid or length <= 0:
        rows.append({'pid':pid,'error':'native process info unavailable','errno':ctypes.get_errno()})
    else:
        rows.append({'pid':pid,'ppid':info.ppid,'startUs':int(info.start_sec)*1000000+int(info.start_usec),
                     'executable':path.value.decode('utf-8','replace')})
print(json.dumps(rows))
`;
async function nativeProcesses(pids) {
    if (!pids.length) return [];
    return JSON.parse((await exec('python3', ['-c', nativeQuery, JSON.stringify(pids)], { maxBuffer: 1024 ** 2 })).stdout);
}
export async function associateCrashpads({ startUs, firstPageUs, pinnedInstall, profile }) {
    const { stdout } = await exec('/bin/ps', ['-Ao', 'pid=,comm=']);
    const pids = stdout.split('\n').flatMap(line => {
        const m = line.match(/^\s*(\d+)\s+(.+)$/);
        return m && basename(m[2]) === 'chrome_crashpad_handler' ? [Number(m[1])] : [];
    });
    const rows = await nativeProcesses(pids), associations = [], unassociated = [];
    for (const row of rows) {
        if (row.error) continue;
        if (!row.executable.startsWith(`${pinnedInstall}/`) || row.startUs < startUs || row.startUs > firstPageUs) {
            unassociated.push({ ...row, reason: !row.executable.startsWith(`${pinnedInstall}/`) ? 'outside pinned install' : 'birth outside this launch interval' });
            continue;
        }
        const evidence = { pid: row.pid, ppid: row.ppid, executable: row.executable,
            launchStartUs: startUs, firstPageUs, processStartUs: row.startUs, pinnedInstall, profile,
            basis: 'Pinned CfT executable AND native process birth within this launch→first-page interval; no blanket Crashpad exemption.' };
        registry.set(row.pid, evidence); associations.push(evidence);
    }
    return { startUs, firstPageUs, pinnedInstall, profile, associations, unassociated,
        nativeErrors: rows.filter(row => row.error) };
}
export function beginBrowserLaunch(options) {
    let resolve;
    const ready = new Promise(done => { resolve = done; });
    pendingLaunches.add(ready);
    const startUs = epochMicroseconds();
    const finish = () => { pendingLaunches.delete(ready); resolve(); };
    return { startUs, finish,
        async firstPage(firstPageUs) {
            try { return await associateCrashpads({ ...options, startUs, firstPageUs }); }
            finally { finish(); }
        } };
}
export async function registeredBenchEvidence(processes) {
    // A poll can coincide with startup. Wait for its measured first-page bound
    // before classifying new orphan handlers; never grant a provisional exemption.
    await Promise.all([...pendingLaunches]);
    const pids = processes.filter(p => registry.has(p.pid) && basename(p.comm) === 'chrome_crashpad_handler').map(p => p.pid);
    const verified = new Map();
    for (const row of await nativeProcesses(pids)) {
        const evidence = registry.get(row.pid);
        if (!row.error && row.startUs === evidence.processStartUs && row.executable === evidence.executable) verified.set(row.pid, evidence);
    }
    return verified;
}
