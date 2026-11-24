import type { ChangeDesc, Text } from '@codemirror/state';
import { overlapsRange } from '../utils/rangeSearch';
import type { CharRange } from '../utils/rangeSearch';
import type { LineMatch } from './analysisLines';
import type { MathRegion } from './latexSource';

export interface BlockPair extends CharRange {
    accepted: boolean;
    latex: string;
}

export interface InlineMath extends CharRange {
    accepted: boolean;
    latex: string;
}

/** Reproduce the global block regex's consuming pairing, including rejected pairs. */
export function pairMathTokens(doc: Text, tokens: readonly number[], code: readonly CharRange[]): BlockPair[] {
    const pairs: BlockPair[] = [];
    let i = 0;
    while (i < tokens.length) {
        const from = tokens[i++];
        while (i < tokens.length && tokens[i] < from + 3) i++;
        if (i === tokens.length) break;
        const to = tokens[i++] + 2;
        const latex = doc.sliceString(from + 2, to - 2).trim();
        pairs.push({ from, to, latex, accepted: !!latex && !overlapsRange(code, from, to) });
        while (i < tokens.length && tokens[i] < to) i++;
    }
    return pairs;
}

/** Resume pairing before the first edited line and reuse the suffix once pairing converges. */
export function updateBlockPairs(previous: readonly BlockPair[], oldDoc: Text, doc: Text,
    changes: ChangeDesc, tokens: readonly number[], code: readonly CharRange[], codeChanged: readonly CharRange[]): BlockPair[] {
    let firstOld = oldDoc.length, lastNew = 0;
    changes.iterChangedRanges((fromA, _toA, _fromB, toB) => {
        firstOld = Math.min(firstOld, oldDoc.lineAt(fromA).from);
        lastNew = Math.max(lastNew, doc.lineAt(toB).to);
    });
    if (changes.empty) return previous.map(pair => overlapsRange(codeChanged, pair.from, pair.to)
        ? { ...pair, accepted: !!pair.latex && !overlapsRange(code, pair.from, pair.to) } : pair);
    let prefix = 0;
    while (prefix < previous.length && previous[prefix].to <= firstOld) prefix++;
    const mapPair = (pair: BlockPair): BlockPair => {
        const from = changes.mapPos(pair.from, 1), to = changes.mapPos(pair.to, -1);
        return { from, to, latex: pair.latex, accepted: overlapsRange(codeChanged, from, to)
            ? !!pair.latex && !overlapsRange(code, from, to) : pair.accepted };
    };
    const result = previous.slice(0, prefix).map(mapPair);
    const start = result.length ? result[result.length - 1].to : 0;
    let lo = 0, hi = tokens.length;
    while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        if (tokens[mid] < start) lo = mid + 1; else hi = mid;
    }
    let i = lo, old = prefix;
    while (i < tokens.length) {
        const from = tokens[i++];
        while (i < tokens.length && tokens[i] < from + 3) i++;
        if (i === tokens.length) break;
        const to = tokens[i++] + 2;
        while (i < tokens.length && tokens[i] < to) i++;
        while (old < previous.length && changes.mapPos(previous[old].from, 1) < from) old++;
        if (from > lastNew && old < previous.length) {
            const candidate = mapPair(previous[old]);
            if (candidate.from === from && candidate.to === to) {
                for (; old < previous.length; old++) result.push(mapPair(previous[old]));
                return result;
            }
        }
        const latex = doc.sliceString(from + 2, to - 2).trim();
        result.push({ from, to, latex, accepted: !!latex && !overlapsRange(code, from, to) });
    }
    return result;
}

export function filterInlineMath(raw: readonly LineMatch[], code: readonly CharRange[], blocks: readonly BlockPair[]): InlineMath[] {
    const acceptedBlocks = blocks.filter(pair => pair.accepted);
    return raw.map(match => {
        const latex = match.groups[0];
        return {
            from: match.from, to: match.to, latex,
            accepted: !latex.endsWith('\\') && !overlapsRange(code, match.from, match.to)
                && !overlapsRange(acceptedBlocks, match.from, match.to),
        };
    });
}

/** Re-filter only matches reached by changed code or accepted block math. */
export function updateInlineMath(raw: readonly LineMatch[], previous: readonly InlineMath[], changes: ChangeDesc,
    code: readonly CharRange[], blocks: readonly BlockPair[], dirty: readonly CharRange[]): InlineMath[] {
    const old = new Map<string, InlineMath>();
    for (const item of previous) {
        const from = changes.mapPos(item.from, 1), to = changes.mapPos(item.to, -1);
        old.set(`${from}:${to}:${item.latex}`, item);
    }
    const acceptedBlocks = blocks.filter(pair => pair.accepted);
    return raw.map(match => {
        const latex = match.groups[0], key = `${match.from}:${match.to}:${latex}`;
        const existing = old.get(key);
        const accepted = existing && !overlapsRange(dirty, match.from, match.to)
            ? existing.accepted
            : !latex.endsWith('\\') && !overlapsRange(code, match.from, match.to)
                && !overlapsRange(acceptedBlocks, match.from, match.to);
        return { from: match.from, to: match.to, latex, accepted };
    });
}

export function acceptedMath(blocks: readonly BlockPair[], inline: readonly InlineMath[]): MathRegion[] {
    const result: MathRegion[] = [];
    let b = 0, i = 0;
    while (b < blocks.length || i < inline.length) {
        if (i === inline.length || (b < blocks.length && blocks[b].from <= inline[i].from)) {
            const pair = blocks[b++];
            if (pair.accepted) result.push({ from: pair.from, to: pair.to, latex: pair.latex, block: true });
        } else {
            const match = inline[i++];
            if (match.accepted) result.push({ from: match.from, to: match.to, latex: match.latex, block: false });
        }
    }
    return result;
}
