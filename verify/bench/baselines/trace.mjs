import { readFile } from 'node:fs/promises';

export async function readTrace(path) {
    const trace = JSON.parse(await readFile(path, 'utf8'));
    return trace.traceEvents ?? [];
}
export function traceFrames(events) {
    const groups = {};
    for (const event of events.filter(e => ['DrawFrame', 'BeginFrame'].includes(e.name))) {
        (groups[`${event.name}/${event.pid}/${event.tid}`] ??= []).push(event.ts / 1000);
    }
    return Object.fromEntries(Object.entries(groups).map(([key, values]) => {
        const times = [...new Set(values)].sort((a, b) => a - b);
        return [key, times.slice(1).map((x, i) => x - times[i])];
    }));
}
export function saveBusyTime(events) {
    const marker = name => {
        const event = events.find(e => e.name === name);
        if (!event) throw new Error(`Missing save trace marker ${name}`);
        return event;
    };
    const input = marker('bme-v08-keyup'), complete = marker('bme-v08-save-complete'), tail = marker('bme-v08-trace-tail');
    const raw = events.filter(e => e.pid === input.pid && e.tid === input.tid && e.ph === 'X' && e.dur > 0 && e.cat?.split(',').includes('toplevel'))
        .map(e => ({ start: e.ts, end: e.ts + e.dur, names: [e.name] })).sort((a, b) => a.start - b.start || b.end - a.end);
    // Some trace categories emit nested top-level aliases. Their interval union
    // counts the renderer's task once, never CPU twice for nested instrumentation.
    const tasks = [];
    for (const task of raw) {
        const last = tasks.at(-1);
        if (last && task.start < last.end) { last.end = Math.max(last.end, task.end); last.names.push(...task.names); }
        else tasks.push({ ...task });
    }
    const inputTask = tasks.find(t => t.start <= input.ts && t.end >= input.ts);
    if (!inputTask) throw new Error('Last edit input has no renderer-main top-level task');
    const start = inputTask.end;
    let quietAfter = complete.ts;
    for (const task of tasks.filter(t => t.end > complete.ts && t.end - t.start > 1000)) {
        if (task.start > quietAfter + 500000) break;
        quietAfter = Math.max(quietAfter, task.end);
    }
    const end = quietAfter + 500000;
    if (complete.ts < start || end > tail.ts) throw new Error('Save did not reach500ms quiescence in captured tail');
    const included = tasks.filter(t => t.start < end && t.end > start).map(t => ({
        startMs: (Math.max(start, t.start) - start) / 1000,
        durationMs: (Math.min(end, t.end) - Math.max(start, t.start)) / 1000,
        names: [...new Set(t.names)],
    }));
    return { busyMs: included.reduce((n, t) => n + t.durationMs, 0), taskCount: included.length,
        longestTaskMs: Math.max(0, ...included.map(t => t.durationMs)), tasks: included,
        pid: input.pid, tid: input.tid, startTraceUs: start, completeTraceUs: complete.ts, endTraceUs: end,
        definition: 'Sum renderer-main top-level task durations after last edit-input task; writable.close + optional retire removeEntry completed; then500ms without task>1ms.' };
}
