import type { ChangeDesc, Text } from '@codemirror/state';
import { containsRange, overlapsRange, type CharRange } from '../utils/rangeSearch';
import { findTables } from './tableModel';

export interface ObjectMatch { from: number; to: number; accepted: boolean }
export interface EmbedMatch extends ObjectMatch { filename: string; width: number | null }

interface Tail { end: number; inspected: number; width: number | null }
export interface ObjectScans {
    embeds: EmbedMatch[];
    tables: ObjectMatch[];
    /** All name terminators, including those belonging to rejected attempts. */
    terminators: number[];
    tails: Map<number, Tail>;
}

interface Change { fromA: number; toA: number; fromB: number; toB: number }

function changesOf(changes: ChangeDesc): Change[] {
    const result: Change[] = [];
    changes.iterChangedRanges((fromA, toA, fromB, toB) => result.push({ fromA, toA, fromB, toB }));
    return result;
}

function touched(from: number, to: number, changes: readonly Change[], inclusive = false): boolean {
    let lo = 0, hi = changes.length;
    while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        if (changes[mid].toA < from) lo = mid + 1; else hi = mid;
    }
    for (let i = lo; i < changes.length && changes[i].fromA <= to; i++) {
        const c = changes[i];
        if (c.fromA === c.toA
            ? (inclusive ? c.fromA >= from && c.fromA <= to : c.fromA > from && c.fromA < to)
            : c.fromA < to && c.toA > from) return true;
    }
    return false;
}

function terminatorsIn(doc: Text, from: number, to: number): number[] {
    const text = doc.sliceString(from, to), result: number[] = [];
    for (let i = 0; i < text.length; i++) if (text[i] === ']' || text[i] === '|') result.push(from + i);
    return result;
}

function nextTerminator(positions: readonly number[], from: number): number | undefined {
    let lo = 0, hi = positions.length;
    while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        if (positions[mid] < from) lo = mid + 1; else hi = mid;
    }
    return positions[lo];
}

function charAt(doc: Text, pos: number): string {
    return pos < doc.length ? doc.sliceString(pos, pos + 1) : '';
}

// A terminator's tail is shared by every opener reaching it. Cache even failed
// attempts: a stray opener followed by a long whitespace tail is not re-read on
// every unrelated keystroke. `inspected` includes the character that failed.
function readTail(doc: Text, at: number): Tail {
    if (charAt(doc, at) === ']') {
        return { end: charAt(doc, at + 1) === ']' ? at + 2 : -1,
            inspected: Math.min(doc.length, at + 2), width: null };
    }
    let p = at + 1;
    while (p < doc.length && /\s/.test(charAt(doc, p))) p++;
    const digits = p;
    while (p < doc.length && /[0-9]/.test(charAt(doc, p))) p++;
    if (p === digits || charAt(doc, p) !== ']' || charAt(doc, p + 1) !== ']') {
        return { end: -1, inspected: Math.min(doc.length, p + 2), width: null };
    }
    return { end: p + 2, inspected: p + 2, width: parseInt(doc.sliceString(digits, p), 10) };
}

function embedsFor(doc: Text, openers: readonly number[], terms: readonly number[], tails: Map<number, Tail>,
    code: readonly CharRange[], math: readonly CharRange[], reusable: ReadonlyMap<number, EmbedMatch>): EmbedMatch[] {
    const embeds: EmbedMatch[] = [];
    let consumed = 0;
    for (const from of openers) {
        if (from < consumed) continue;
        const old = reusable.get(from);
        if (old) {
            const match = { ...old, accepted: !overlapsRange(code, from, old.to) && !overlapsRange(math, from, old.to) };
            embeds.push(match);
            consumed = match.to;
            continue;
        }
        const term = nextTerminator(terms, from + 3);
        if (term === undefined || term === from + 3) continue;
        let tail = tails.get(term);
        if (!tail) { tail = readTail(doc, term); tails.set(term, tail); }
        if (tail.end < 0) continue;
        const to = tail.end;
        embeds.push({ from, to, filename: doc.sliceString(from + 3, term).trim(), width: tail.width,
            accepted: !overlapsRange(code, from, to) && !overlapsRange(math, from, to) });
        consumed = to;
    }
    return embeds;
}

interface RegexLine { from: number; to: number; text: string }

// Regex ^/m also sees U+2028 and U+2029, unlike CodeMirror's line model.
// Cache each CM line's separators: repeatedly slicing a single long CM line
// with thousands of regex lines would otherwise make a region walk quadratic.
function regexLines(doc: Text): (pos: number) => RegexLine {
    const cache = new Map<number, { text: string; separators: number[] }>();
    return position => {
        const pos = Math.max(0, Math.min(position, doc.length));
        const line = doc.lineAt(pos);
        let entry = cache.get(line.from);
        if (!entry) {
            const text = line.text, separators: number[] = [];
            for (let i = 0; i < text.length; i++) if (text[i] === '\u2028' || text[i] === '\u2029') separators.push(i);
            entry = { text, separators };
            cache.set(line.from, entry);
        }
        const at = Math.min(pos - line.from, entry.text.length);
        let lo = 0, hi = entry.separators.length;
        while (lo < hi) {
            const mid = (lo + hi) >>> 1;
            if (entry.separators[mid] < at) lo = mid + 1; else hi = mid;
        }
        const from = lo ? entry.separators[lo - 1] + 1 : 0;
        const to = entry.separators[lo] ?? entry.text.length;
        return { from: line.from + from, to: line.from + to, text: entry.text.slice(from, to) };
    };
}

function isBarrier(line: string): boolean {
    return !line.startsWith('|') && !/^[\s:|-]*$/.test(line);
}

function tableRegion(doc: Text, lineAt: (pos: number) => RegexLine, pos: number): CharRange {
    const line = lineAt(pos);
    let from = line.from, to = line.to;
    while (from > 0) {
        const previous = lineAt(from - 1);
        if (isBarrier(previous.text)) break;
        from = previous.from;
    }
    while (to < doc.length) {
        const next = lineAt(to + 1);
        if (isBarrier(next.text)) { to = next.from; break; }
        to = next.to;
    }
    return { from, to };
}

function mergeRanges(ranges: CharRange[]): CharRange[] {
    ranges.sort((a, b) => a.from - b.from || a.to - b.to);
    const merged: CharRange[] = [];
    for (const range of ranges) {
        const last = merged[merged.length - 1];
        if (last && range.from <= last.to) last.to = Math.max(last.to, range.to);
        else merged.push({ ...range });
    }
    return merged;
}

function tableMatches(doc: Text, windows: readonly CharRange[], code: readonly CharRange[]): ObjectMatch[] {
    const result: ObjectMatch[] = [];
    for (const window of windows) for (const span of findTables(doc.sliceString(window.from, window.to))) {
        const from = window.from + span.from, to = window.from + span.to;
        result.push({ from, to, accepted: !containsRange(code, from, to) });
    }
    return result;
}

export function scanObjects(doc: Text, code: readonly CharRange[], math: readonly CharRange[]): ObjectScans {
    const text = doc.toString();
    const openers: number[] = [];
    for (let at = text.indexOf('![['); at !== -1; at = text.indexOf('![[', at + 1)) openers.push(at);
    const terminators = terminatorsIn(doc, 0, doc.length), tails = new Map<number, Tail>();
    return { embeds: embedsFor(doc, openers, terminators, tails, code, math, new Map()),
        tables: tableMatches(doc, [{ from: 0, to: doc.length }], code), terminators, tails };
}

export function updateObjects(previous: ObjectScans, oldDoc: Text, doc: Text, changes: ChangeDesc,
    openers: readonly number[], code: readonly CharRange[], math: readonly CharRange[]): ObjectScans {
    const edits = changesOf(changes);
    const terminators: number[] = [];
    let edit = 0;
    for (const pos of previous.terminators) {
        while (edit < edits.length && edits[edit].toA <= pos) edit++;
        if (edit < edits.length && edits[edit].fromA <= pos && pos < edits[edit].toA) continue;
        terminators.push(changes.mapPos(pos, 1));
    }
    for (const c of edits) terminators.push(...terminatorsIn(doc, c.fromB, c.toB));
    terminators.sort((a, b) => a - b);
    const tails = new Map<number, Tail>();
    for (const [pos, tail] of previous.tails) {
        if (touched(pos, tail.inspected, edits, true)) continue;
        tails.set(changes.mapPos(pos, 1), { ...tail,
            end: tail.end < 0 ? -1 : changes.mapPos(tail.end, -1), inspected: changes.mapPos(tail.inspected, -1) });
    }
    const reusable = new Map<number, EmbedMatch>();
    for (const match of previous.embeds) {
        if (touched(match.from, match.to, edits)) continue;
        const from = changes.mapPos(match.from, 1), to = changes.mapPos(match.to, -1);
        reusable.set(from, { ...match, from, to });
    }
    const embeds = embedsFor(doc, openers, terminators, tails, code, math, reusable);

    const oldLines = regexLines(oldDoc), newLines = regexLines(doc);
    const oldWindows = mergeRanges(edits.map(c => ({ from: tableRegion(oldDoc, oldLines, c.fromA).from, to: tableRegion(oldDoc, oldLines, c.toA).to })));
    const newWindows = mergeRanges(oldWindows.map(window => {
        const from = changes.mapPos(window.from, -1), to = changes.mapPos(window.to, 1);
        return { from: tableRegion(doc, newLines, from).from, to: tableRegion(doc, newLines, to).to };
    }));
    const kept = previous.tables.filter(table => !overlapsRange(oldWindows, table.from, table.to))
        .map(table => {
            const from = changes.mapPos(table.from, 1), to = changes.mapPos(table.to, -1);
            return { from, to, accepted: !containsRange(code, from, to) };
        }).filter(table => !overlapsRange(newWindows, table.from, table.to));
    const tables = [...kept, ...tableMatches(doc, newWindows, code)].sort((a, b) => a.from - b.from);
    return { embeds, tables, terminators, tails };
}
