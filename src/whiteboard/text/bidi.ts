import { bidiBracket, unicodeProperty } from './unicode';

export interface BidiCharacter {
    readonly start: number;
    readonly end: number;
    readonly level: number;
    readonly originalType: string;
    readonly removed: boolean;
}
export interface BidiParagraph { readonly level: number; readonly characters: readonly BidiCharacter[] }
type Direction = 'auto' | 'ltr' | 'rtl';
interface Item { cp: number; start: number; end: number; original: string; type: string; level: number; match: number; removed: boolean }
interface Status { level: number; override: '' | 'L' | 'R'; isolate: boolean }
const oneOf = (s: string, ...values: string[]) => values.includes(s);
const isolate = (s: string) => oneOf(s, 'LRI', 'RLI', 'FSI');
const direction = (level: number) => level % 2 ? 'R' : 'L';
const strong = (s: string) => s === 'L' ? 'L' : oneOf(s, 'R', 'AN', 'EN') ? 'R' : '';

/** Resolve one paragraph, retaining removed formatting characters for source mapping. */
export function resolveBidi(text: string, dir: Direction = 'auto'): BidiParagraph {
    const chars: Item[] = [];
    let start = 0;
    for (const c of text) {
        const cp = c.codePointAt(0)!;
        const type = unicodeProperty('bidiClass', cp);
        chars.push({ cp, start, end: start + c.length, original: type, type, level: 0, match: -1, removed: oneOf(type, 'RLE', 'LRE', 'RLO', 'LRO', 'PDF', 'BN') });
        start += c.length;
    }
    // Match isolates and find the first strong type in each isolate's own scope.
    const stack: number[] = [];
    const first = new Map<number, string>();
    for (let i = 0; i < chars.length; i++) {
        const t = chars[i].original;
        if (isolate(t)) stack.push(i);
        else if (t === 'PDI') {
            const open = stack.pop();
            if (open !== undefined) { chars[open].match = i; chars[i].match = open; }
        } else if (oneOf(t, 'L', 'R', 'AL')) {
            const scope = stack.length ? stack[stack.length - 1] : -1;
            if (!first.has(scope)) first.set(scope, t);
        }
    }
    const para = dir === 'rtl' ? 1 : dir === 'ltr' ? 0 : oneOf(first.get(-1) ?? '', 'R', 'AL') ? 1 : 0;
    const statuses: Status[] = [{ level: para, override: '', isolate: false }];
    let overflowIsolate = 0, overflowEmbedding = 0, validIsolate = 0;
    for (let i = 0; i < chars.length; i++) {
        const item = chars[i], t = item.original;
        let current = statuses[statuses.length - 1];
        item.level = current.level;
        if (oneOf(t, 'RLE', 'LRE', 'RLO', 'LRO') || isolate(t)) {
            const isIso = isolate(t);
            if (isIso && current.override) item.type = current.override;
            const odd = oneOf(t, 'RLE', 'RLO', 'RLI') || (t === 'FSI' && oneOf(first.get(i) ?? '', 'R', 'AL'));
            const next = current.level + (odd === (current.level % 2 === 0) ? 1 : 2);
            if (next <= 125 && overflowIsolate === 0 && overflowEmbedding === 0) {
                statuses.push({ level: next, override: t === 'RLO' ? 'R' : t === 'LRO' ? 'L' : '', isolate: isIso });
                if (isIso) validIsolate++;
            } else if (isIso) overflowIsolate++;
            else if (!overflowIsolate) overflowEmbedding++;
        } else if (t === 'PDI') {
            if (overflowIsolate) overflowIsolate--;
            else if (validIsolate) {
                overflowEmbedding = 0;
                while (!statuses[statuses.length - 1].isolate) statuses.pop();
                statuses.pop(); validIsolate--;
            }
            current = statuses[statuses.length - 1];
            item.level = current.level;
            if (current.override) item.type = current.override;
        } else if (t === 'PDF') {
            if (!overflowIsolate) {
                if (overflowEmbedding) overflowEmbedding--;
                else if (statuses.length > 1 && !current.isolate) statuses.pop();
            }
        } else if (t === 'B') item.level = para;
        else if (t !== 'BN' && current.override) item.type = current.override;
    }
    const visible = chars.map((c, i) => c.removed ? -1 : i).filter(i => i >= 0);
    const positions = new Map<number, number>();
    visible.forEach((value, i) => positions.set(value, i));
    const runs: number[][] = [];
    const runOf = new Map<number, number>();
    for (const index of visible) {
        let run = runs[runs.length - 1];
        if (!run || chars[run[0]].level !== chars[index].level) { run = []; runs.push(run); }
        runOf.set(index, runs.length - 1);
        run.push(index);
    }
    const nextRun = new Map<number, number>();
    const hasPrevious = new Set<number>();
    runs.forEach((run, r) => {
        const last = chars[run[run.length - 1]];
        if (!isolate(last.original) || last.match < 0) return;
        const next = runOf.get(last.match);
        if (next !== undefined && next !== r) { nextRun.set(r, next); hasPrevious.add(next); }
    });
    const explicitLevels = chars.map(c => c.level);
    for (let r = 0; r < runs.length; r++) {
        if (hasPrevious.has(r)) continue;
        const seq: number[] = [];
        let current: number | undefined = r;
        while (current !== undefined) { for (const index of runs[current]) seq.push(index); current = nextRun.get(current); }
        const firstIndex = seq[0], lastIndex = seq[seq.length - 1];
        const firstPos = positions.get(firstIndex)!, lastPos = positions.get(lastIndex)!;
        const before = firstPos > 0 ? explicitLevels[visible[firstPos - 1]] : para;
        const after = lastPos + 1 < visible.length && !isolate(chars[lastIndex].original) ? explicitLevels[visible[lastPos + 1]] : para;
        resolveSequence(chars, seq, direction(Math.max(explicitLevels[firstIndex], before)), direction(Math.max(explicitLevels[lastIndex], after)));
    }
    return { level: para, characters: chars.map(c => ({ start: c.start, end: c.end, level: c.level, originalType: c.original, removed: c.removed })) };
}

function resolveSequence(chars: Item[], seq: number[], sos: string, eos: string): void {
    const c = seq.map(i => chars[i]);
    let previous = sos;
    for (const x of c) { if (x.type === 'NSM') x.type = isolate(previous) || previous === 'PDI' ? 'ON' : previous; previous = x.type; }
    let lastStrong = sos;
    for (const x of c) { if (x.type === 'EN' && lastStrong === 'AL') x.type = 'AN'; if (oneOf(x.type, 'L', 'R', 'AL')) lastStrong = x.type; }
    for (const x of c) if (x.type === 'AL') x.type = 'R';
    for (let i = 1; i + 1 < c.length; i++) {
        const a = c[i - 1].type, b = c[i].type, d = c[i + 1].type;
        if (a === d && (a === 'EN' && oneOf(b, 'ES', 'CS') || a === 'AN' && b === 'CS')) c[i].type = a;
    }
    for (let i = 0; i < c.length;) {
        if (c[i].type !== 'ET') { i++; continue; }
        const from = i;
        while (i < c.length && c[i].type === 'ET') i++;
        if ((from && c[from - 1].type === 'EN') || (i < c.length && c[i].type === 'EN')) for (let j = from; j < i; j++) c[j].type = 'EN';
    }
    for (const x of c) if (oneOf(x.type, 'ES', 'ET', 'CS')) x.type = 'ON';
    lastStrong = sos;
    for (const x of c) { if (x.type === 'EN' && lastStrong === 'L') x.type = 'L'; if (oneOf(x.type, 'L', 'R')) lastStrong = x.type; }
    resolveBrackets(c, sos);
    for (let i = 0; i < c.length;) {
        if (!oneOf(c[i].type, 'B', 'S', 'WS', 'ON', 'FSI', 'LRI', 'RLI', 'PDI')) { i++; continue; }
        const from = i;
        while (i < c.length && oneOf(c[i].type, 'B', 'S', 'WS', 'ON', 'FSI', 'LRI', 'RLI', 'PDI')) i++;
        const left = from ? strong(c[from - 1].type) : sos;
        const right = i < c.length ? strong(c[i].type) : eos;
        for (let j = from; j < i; j++) c[j].type = left === right ? left : direction(c[j].level);
    }
    for (const x of c) {
        if (x.level % 2 === 0) { if (x.type === 'R') x.level++; else if (oneOf(x.type, 'AN', 'EN')) x.level += 2; }
        else if (oneOf(x.type, 'L', 'AN', 'EN')) x.level++;
    }
}

function resolveBrackets(c: Item[], sos: string): void {
    const openings: { index: number; pair: number }[] = [];
    const pairs: [number, number][] = [];
    for (let i = 0; i < c.length; i++) {
        if (c[i].type !== 'ON') continue;
        const bracket = bidiBracket(c[i].cp);
        if (!bracket) continue;
        if (bracket.open) { if (openings.length === 63) break; openings.push({ index: i, pair: bracket.pair }); }
        else {
            let j = openings.length - 1;
            while (j >= 0 && openings[j].pair !== c[i].cp && !(openings[j].pair === 0x232a && c[i].cp === 0x3009) && !(openings[j].pair === 0x3009 && c[i].cp === 0x232a)) j--;
            if (j >= 0) { pairs.push([openings[j].index, i]); openings.length = j; }
        }
    }
    pairs.sort((a, b) => a[0] - b[0]);
    for (const [open, close] of pairs) {
        const embedding = direction(c[open].level);
        let inner = '';
        for (let i = open + 1; i < close; i++) { const s = strong(c[i].type); if (s === embedding) { inner = s; break; } if (s) inner = s; }
        if (!inner) continue;
        let resolved = embedding;
        if (inner !== embedding) {
            let preceding = sos;
            for (let i = open - 1; i >= 0; i--) { const s = strong(c[i].type); if (s) { preceding = s; break; } }
            if (preceding === inner) resolved = inner;
        }
        c[open].type = c[close].type = resolved;
        for (const index of [open, close]) for (let i = index + 1; i < c.length && c[i].original === 'NSM'; i++) c[i].type = resolved;
    }
}

/** L1/L2: visual order of source character indices for a wrapped line. */
export function reorderBidiLine(paragraph: BidiParagraph, from: number, to: number): number[] {
    const chars = paragraph.characters;
    const order: number[] = [];
    const levels: number[] = [];
    for (let i = 0; i < chars.length; i++) if (!chars[i].removed && chars[i].start >= from && chars[i].end <= to) { order.push(i); levels.push(chars[i].level); }
    const resettable = (t: string) => oneOf(t, 'WS', 'FSI', 'LRI', 'RLI', 'PDI');
    for (let i = 0; i < order.length; i++) if (oneOf(chars[order[i]].originalType, 'S', 'B')) {
        levels[i] = paragraph.level;
        for (let j = i - 1; j >= 0 && resettable(chars[order[j]].originalType); j--) levels[j] = paragraph.level;
    }
    for (let i = order.length - 1; i >= 0 && resettable(chars[order[i]].originalType); i--) levels[i] = paragraph.level;
    let max = 0, minOdd = Infinity;
    for (const level of levels) { max = Math.max(max, level); if (level % 2) minOdd = Math.min(minOdd, level); }
    for (let level = max; level >= minOdd; level--) for (let i = 0; i < order.length;) {
        if (levels[i] < level) { i++; continue; }
        let end = i + 1;
        while (end < order.length && levels[end] >= level) end++;
        for (let a = i, b = end - 1; a < b; a++, b--) { [order[a], order[b]] = [order[b], order[a]]; [levels[a], levels[b]] = [levels[b], levels[a]]; }
        i = end;
    }
    return order;
}
