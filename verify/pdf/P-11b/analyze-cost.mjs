// Reanalyze saved real-browser traces; never generate synthetic timing samples.
import { readFile, writeFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { analysisVersion, summarizeTrace, summarizeCosts } from '../lib/textCostTrace.mjs';
const [input, output] = process.argv.slice(2);
if (!input || !output || process.argv.length !== 4) throw new Error('Input browser result.json and a fresh output JSON are required');
const report = JSON.parse(await readFile(input));
if (!report.sessions?.length || report.executionError) throw new Error('No completed browser samples to analyze');
for (const session of report.sessions) {
    const trace = JSON.parse(await readFile(resolve(dirname(input), session.trace)));
    session.tracePhases = session.observations.phases.map(phase => summarizeTrace(trace.traceEvents, phase));
}
report.analysisVersion = analysisVersion;
report.reanalyzedFrom = input;
report.summary = summarizeCosts(report);
await writeFile(output, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
console.log(JSON.stringify(report.summary, null, 2));
