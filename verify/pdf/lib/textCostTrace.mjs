export const analysisVersion = '2: V8 call/constructor/module slices included; nested RunTask events collapsed';

export function summarizeTrace(events, phase) {
    const marker = suffix => events.find(event => event.name === 'TimeStamp' && event.args?.data?.message === `P11b:${phase.name}:${suffix}`);
    const first = marker('first'), populated = marker('populated'), settled = marker('settled');
    if (!first || !populated || !settled || !phase.built) throw new Error(`Missing observed trace phase: ${phase.name}`);
    const main = events.filter(event => event.pid === first.pid && event.tid === first.tid && event.ph === 'X' && event.dur > 0 && event.ts < settled.ts && event.ts + event.dur > first.ts);
    const script = main.filter(event => /^(FunctionCall|EvaluateScript|EvaluateModule|RunMicrotasks|V8\.RunMicrotasks|v8\.(execute|callFunction|evaluateModule|newInstance|compileModule|compile|run)|V8\.Execute)$/.test(event.name));
    if (!script.length) throw new Error('No main-thread scripting slices observed');
    const union = slices => {
        const intervals = slices.map(event => [Math.max(first.ts, event.ts), Math.min(settled.ts, event.ts + event.dur)]).sort((a, b) => a[0] - b[0]);
        let us = 0, end = -Infinity;
        for (const [a, b] of intervals) { us += Math.max(0, b - Math.max(a, end)); end = Math.max(end, b); }
        return us / 1000;
    };
    const tasks = main.filter(event => /RunTask$/.test(event.name)).sort((a, b) => a.ts - b.ts || b.dur - a.dur);
    const outer = [];
    for (const task of tasks) {
        const previous = outer.at(-1);
        if (!previous || task.ts >= previous.ts + previous.dur) outer.push({ ts: task.ts, dur: task.dur });
        else if (task.ts + task.dur > previous.ts + previous.dur) previous.dur = task.ts + task.dur - previous.ts;
    }
    const scriptingMs = union(script);
    return { name: phase.name, built: phase.built, populatedMs: (populated.ts - first.ts) / 1000, settledMs: (settled.ts - first.ts) / 1000, scriptingMs, scriptingPerLayerMs: scriptingMs / phase.built,
        mainTaskMs: union(outer), layoutMs: union(main.filter(event => /^(UpdateLayoutTree|Layout)$/.test(event.name))),
        longTasks: outer.filter(event => event.dur >= 50_000).map(event => ({ startUs: event.ts, durationMs: event.dur / 1000 })),
        source: 'Union of trace scripting intervals on timestamp-marker thread; callback/native callee time included; no nested-duration double counting' };
}

export function summarizeCosts(report) {
    const median = values => { const sorted = [...values].sort((a, b) => a - b); return (sorted[Math.floor((sorted.length - 1) / 2)] + sorted[Math.floor(sorted.length / 2)]) / 2; };
    return [...new Set(report.sessions.map(row => row.fixture.id))].map(id => {
        const totals = arm => report.sessions.filter(row => row.arm === arm && row.fixture.id === id).map(row => ({ populatedMs: row.tracePhases.reduce((n, p) => n + p.populatedMs, 0), scriptingMs: row.tracePhases.reduce((n, p) => n + p.scriptingMs, 0), built: row.tracePhases.reduce((n, p) => n + p.built, 0), longTasks: row.tracePhases.reduce((n, p) => n + p.longTasks.length, 0) }));
        const summarize = values => Object.fromEntries(['populatedMs', 'scriptingMs', 'built', 'longTasks'].map(key => [key, median(values.map(row => row[key]))]));
        const a = summarize(totals('fixed')), b = summarize(totals('omitted'));
        return { fixture: id, fixed: a, omitted: b, scriptingDeltaMs: a.scriptingMs - b.scriptingMs, estimatedDeltaPerBuiltLayerMs: (a.scriptingMs - b.scriptingMs) / a.built, populatedDeltaMs: a.populatedMs - b.populatedMs,
            interpretation: 'Advisory difference of total phase scripting, not an isolated helper timer or confidence/no-regression result' };
    });
}
