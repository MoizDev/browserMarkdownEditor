import type { WorkerContext } from '../../platform/workers/serve';
import type { MatchBatch, MatchConfig, MatchProgress } from './types';

const MAX_MATCHES_PER_FILE = 50;
const MAX_MATCH_LINE = 300;

function matchLine(line: string, re: RegExp): string {
    const trimmed = line.trim();
    if (trimmed.length <= MAX_MATCH_LINE) return trimmed;
    re.lastIndex = 0;
    const at = Math.max(0, (re.exec(line)?.index ?? 0) - 100);
    return `${at > 0 ? '…' : ''}${line.slice(at, at + MAX_MATCH_LINE)}…`;
}

// Only the worker imports this module as code. In particular filename tests and the second
// snippet-position exec stay here: moving just the content test would leave two UI freeze paths.
export function createMatching(config: MatchConfig) {
    const escaped = config.query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(config.regex ? config.query : escaped, config.caseSensitive ? '' : 'i');
    let count = 0;
    let fileCount = 0;
    let inFile = 0;
    let hitHere = false;
    let stopped = false;
    let lineNumber = 1;
    let carry: string[] = [];

    return async (batch: MatchBatch, context: WorkerContext): Promise<MatchProgress> => {
        const out: string[] = [];
        let doneFile = false;
        const hit = () => { if (!hitHere) { hitHere = true; fileCount++; } };
        const snapshot = (): MatchProgress => ({ out, count, fileCount, stopped, doneFile });
        if (batch.first) {
            if (count >= config.maxResults) { stopped = true; doneFile = true; return snapshot(); }
            inFile = 0;
            hitHere = false;
            lineNumber = 1;
            carry = [];
            if (re.test(batch.name)) { out.push(`${batch.path} (file name matches)`); count++; hit(); }
        }
        if (!batch.textFile) { doneFile = true; return snapshot(); }
        const line = (text: string) => {
            if (re.test(text)) {
                if (count >= config.maxResults) { stopped = true; doneFile = true; return; }
                if (inFile >= MAX_MATCHES_PER_FILE) {
                    out.push(`${batch.path}: …more matches in this file (search it alone with path to see them)`);
                    doneFile = true;
                    return;
                }
                out.push(`${batch.path}:${lineNumber}: ${matchLine(text, re)}`);
                count++;
                inFile++;
                hit();
            }
            lineNumber++;
        };
        let offset = 0;
        let sliced = performance.now();
        while (!doneFile) {
            const newline = batch.text.indexOf('\n', offset);
            if (newline < 0) {
                const tail = batch.text.slice(offset);
                if (batch.last) {
                    line(carry.length ? carry.join('') + tail : tail);
                    carry = [];
                    doneFile = true;
                } else carry.push(tail);
                break;
            }
            const part = batch.text.slice(offset, newline);
            line(carry.length ? carry.join('') + part : part);
            carry = [];
            offset = newline + 1;
            if (performance.now() - sliced >= 8) { await context.slice(); sliced = performance.now(); }
        }
        if (doneFile) carry = [];
        return snapshot();
    };
}
