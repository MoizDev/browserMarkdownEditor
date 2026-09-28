// The line diff behind the agent panel's change cards: what one vault_edit /
// vault_write / vault_create did to a file, as a compact unified diff.
//
// Myers' O((N+M)·D) algorithm on the lines left after trimming the common head
// and tail — an agent edit is nearly always a few lines in a long note, so the
// trim alone usually leaves almost nothing to compare. Past MAX_EDIT_DISTANCE
// the middle is shown as "all of it went, all of this came" instead: correct,
// just less minimal, and it keeps a whole-file rewrite of a 20k-line file from
// costing seconds and an O(D²) trace on the main thread.

import type { DiffLine } from '../types/vaultAgent';

/** Lines of unchanged text kept around each change. */
const CONTEXT = 3;
/** Rows a card may carry; a card is for reading, the file is the record. */
const MAX_ROWS = 400;
/** A single row's text; a minified line is not worth 200 KB of card. */
const MAX_ROW_CHARS = 400;
/** Past this many inserted+deleted lines, stop looking for the minimal diff.
 *  The trace is ~D² ints, so 1000 ≈ 4 MB at worst. */
const MAX_EDIT_DISTANCE = 1000;

type Op = { type: 'context' | 'add' | 'del'; text: string; oldLine?: number; newLine?: number };

export interface LineDiff {
    /** Hunks with CONTEXT lines around each change, `gap` rows between them. */
    diff: DiffLine[];
    added: number;
    removed: number;
}

function splitLines(text: string): string[] {
    return text === '' ? [] : text.split('\n');
}

/** Myers' shortest edit script, as the sequence of kept/added/deleted lines
 *  (`a`, `b` are interned line ids). null when it would exceed `maxD`. */
function myers(a: Int32Array, b: Int32Array, maxD: number): Array<'=' | '+' | '-'> | null {
    const n = a.length;
    const m = b.length;
    const max = n + m;
    const offset = max + 1;
    const v = new Int32Array(2 * max + 3);
    const trace: Int32Array[] = [];
    for (let d = 0; d <= Math.min(max, maxD); d++) {
        // The state BEFORE round d, for k in [-d, d] — all backtracking reads.
        trace.push(v.slice(offset - d, offset + d + 1));
        for (let k = -d; k <= d; k += 2) {
            let x = k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1])
                ? v[offset + k + 1]
                : v[offset + k - 1] + 1;
            let y = x - k;
            while (x < n && y < m && a[x] === b[y]) { x++; y++; }
            v[offset + k] = x;
            if (x >= n && y >= m) return backtrack(trace, n, m, d);
        }
    }
    return null;
}

function backtrack(trace: Int32Array[], n: number, m: number, dEnd: number): Array<'=' | '+' | '-'> {
    const ops: Array<'=' | '+' | '-'> = [];
    let x = n;
    let y = m;
    for (let d = dEnd; d > 0; d--) {
        const v = trace[d];
        const at = (k: number) => v[k + d];
        const k = x - y;
        const prevK = k === -d || (k !== d && at(k - 1) < at(k + 1)) ? k + 1 : k - 1;
        const prevX = at(prevK);
        const prevY = prevX - prevK;
        while (x > prevX && y > prevY) { ops.push('='); x--; y--; }
        if (x === prevX) { ops.push('+'); y--; } else { ops.push('-'); x--; }
    }
    while (x > 0 && y > 0) { ops.push('='); x--; y--; }
    return ops.reverse();
}

function clip(text: string): string {
    return text.length > MAX_ROW_CHARS ? `${text.slice(0, MAX_ROW_CHARS)}… (${text.length - MAX_ROW_CHARS} more chars)` : text;
}

/** Every line of `before` → `after`, as context/add/del rows with line numbers. */
function fullScript(before: string, after: string): Op[] {
    const a = splitLines(before);
    const b = splitLines(after);
    let head = 0;
    while (head < a.length && head < b.length && a[head] === b[head]) head++;
    let tail = 0;
    while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;

    const ops: Op[] = [];
    for (let i = 0; i < head; i++) ops.push({ type: 'context', text: a[i], oldLine: i + 1, newLine: i + 1 });

    const midA = a.slice(head, a.length - tail);
    const midB = b.slice(head, b.length - tail);
    const ids = new Map<string, number>();
    const intern = (lines: string[]) => Int32Array.from(lines, l => {
        let id = ids.get(l);
        if (id === undefined) ids.set(l, (id = ids.size));
        return id;
    });
    const script = myers(intern(midA), intern(midB), MAX_EDIT_DISTANCE)
        ?? [...midA.map(() => '-' as const), ...midB.map(() => '+' as const)];
    let i = 0;
    let j = 0;
    for (const step of script) {
        if (step === '=') { ops.push({ type: 'context', text: midA[i], oldLine: head + i + 1, newLine: head + j + 1 }); i++; j++; }
        else if (step === '-') { ops.push({ type: 'del', text: midA[i], oldLine: head + i + 1 }); i++; }
        else { ops.push({ type: 'add', text: midB[j], newLine: head + j + 1 }); j++; }
    }
    for (let t = 0; t < tail; t++) {
        const oi = a.length - tail + t;
        const ni = b.length - tail + t;
        ops.push({ type: 'context', text: a[oi], oldLine: oi + 1, newLine: ni + 1 });
    }
    return ops;
}

/** The compact diff from `before` to `after`. */
export function lineDiff(before: string, after: string): LineDiff {
    const ops = fullScript(before, after);
    let added = 0;
    let removed = 0;
    for (const op of ops) {
        if (op.type === 'add') added++;
        else if (op.type === 'del') removed++;
    }

    // Keep each change plus CONTEXT lines either side; everything else folds
    // into one `gap` row per run.
    const keep = new Uint8Array(ops.length);
    ops.forEach((op, idx) => {
        if (op.type === 'context') return;
        for (let k = Math.max(0, idx - CONTEXT); k <= Math.min(ops.length - 1, idx + CONTEXT); k++) keep[k] = 1;
    });

    const diff: DiffLine[] = [];
    let skipped = 0;
    let shownChanges = 0;
    const flushGap = () => {
        if (skipped > 0) diff.push({ type: 'gap', text: `${skipped} unchanged line${skipped === 1 ? '' : 's'}` });
        skipped = 0;
    };
    for (let idx = 0; idx < ops.length; idx++) {
        if (!keep[idx]) { skipped++; continue; }
        if (diff.length >= MAX_ROWS) {
            const hidden = added + removed - shownChanges;
            diff.push({ type: 'gap', text: hidden > 0 ? `… ${hidden} more changed line${hidden === 1 ? '' : 's'} not shown` : '…' });
            return { diff, added, removed };
        }
        flushGap();
        const op = ops[idx];
        if (op.type !== 'context') shownChanges++;
        diff.push({ ...op, text: clip(op.text) });
    }
    // A trailing run of unchanged lines is not worth a row after the last hunk,
    // but a leading one is (it says where the hunk sits); only mid gaps and the
    // head get rows, so drop the tail.
    return { diff, added, removed };
}

/** A new file, as a card: every line added (capped like any diff). */
export function creationDiff(text: string): LineDiff {
    return lineDiff('', text);
}
