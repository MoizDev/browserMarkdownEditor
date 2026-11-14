import { StateField } from '@codemirror/state';
import type { EditorState, Transaction } from '@codemirror/state';
import { syntaxTree } from '@codemirror/language';
import type { Tree } from '@lezer/common';
import { scanAllLines, updateLineScans } from './analysisLines';
import type { LineMatch, LineScans } from './analysisLines';
import { acceptedMath, filterInlineMath, pairMathTokens, updateBlockPairs, updateInlineMath } from './analysisMath';
import type { BlockPair, InlineMath } from './analysisMath';
import { mergeAnalysisRanges, treeDelta } from './analysisTree';
import { scanObjects, updateObjects } from './analysisObjects';
import { codeRangesForTree } from '../utils/mathRegions';
import { incrementalEditorEnabled } from '../utils/engineRouting';
import { overlapsRange } from '../utils/rangeSearch';
import type { CharRange } from '../utils/rangeSearch';

import type { AnalysisDelta, DocAnalysis, FilteredLineMatch } from './docAnalysisTypes';
export type { AnalysisDelta, DocAnalysis } from './docAnalysisTypes';

function makeAnalysis(state: EditorState, tree: Tree, rev: number, codeRanges: CharRange[],
    lines: LineScans, blockPairs: BlockPair[], delta: AnalysisDelta | null,
    update?: { previous: DocAnalysis; transaction: Transaction; inlineRaw: InlineMath[]; dirty: CharRange[] }): DocAnalysis {
    const inlineRaw = update?.inlineRaw ?? filterInlineMath(lines.inline, codeRanges, blockPairs);
    const mathRegions = acceptedMath(blockPairs, inlineRaw);
    const outside = (item: LineMatch) => !overlapsRange(codeRanges, item.from, item.to)
        && !overlapsRange(mathRegions, item.from, item.to);
    const filter = (raw: LineMatch[], previous: FilteredLineMatch[] | undefined, accept: (item: LineMatch) => boolean): FilteredLineMatch[] => {
        const old = new Map<string, FilteredLineMatch>();
        if (previous && update) for (const item of previous) {
            const from = update.transaction.changes.mapPos(item.from, 1), to = update.transaction.changes.mapPos(item.to, -1);
            old.set(`${from}:${to}:${item.groups.join('\0')}`, item);
        }
        return raw.map(item => {
            const existing = old.get(`${item.from}:${item.to}:${item.groups.join('\0')}`);
            const accepted = existing && update && !overlapsRange(update.dirty, item.from, item.to)
                ? existing.accepted : accept(item);
            return { ...item, accepted };
        });
    };
    const dollarRuns = filter(lines.dollars, update?.previous.dollarRuns, item => (item.to - item.from) % 2 === 0
        && state.sliceDoc(Math.max(0, item.from - 1), item.from) !== '\\' && outside(item));
    const highlights = filter(lines.highlights, update?.previous.highlights, outside);
    const wikilinks = filter(lines.wikilinks, update?.previous.wikilinks, item => item.groups[0] !== '!' && outside(item));
    const objects = update
        ? updateObjects(update.previous.objects, update.transaction.startState.doc, state.doc,
            update.transaction.changes, lines.embedOpeners, codeRanges, mathRegions)
        : scanObjects(state.doc, codeRanges, mathRegions);
    return { rev, treeLength: tree.length, tree, codeRanges, mathRegions, mathEnds: mathRegions.map(region => region.to), lines,
        dollarRuns, highlights, wikilinks, blockPairs, inlineRaw, objects, delta };
}

export function analyzeDocFull(state: EditorState): DocAnalysis {
    const tree = syntaxTree(state), codeRanges = codeRangesForTree(tree);
    const lines = scanAllLines(state.doc);
    const pairs = pairMathTokens(state.doc, lines.mathTokens, codeRanges);
    return makeAnalysis(state, tree, 0, codeRanges, lines, pairs, null);
}

function updateCodeRanges(previous: readonly CharRange[], tree: Tree, tr: Transaction,
    changed: readonly CharRange[]): CharRange[] {
    const found: CharRange[] = [];
    for (const range of changed) tree.iterate({
        from: range.from, to: range.to,
        enter(node) {
            if (node.name === 'FencedCode' || node.name === 'CodeBlock' || node.name === 'InlineCode') {
                found.push({ from: node.from, to: node.to });
                return false;
            }
        },
    });
    const retained = previous.map(range => ({ from: tr.changes.mapPos(range.from, 1),
        to: tr.changes.mapPos(range.to, -1) })).filter(range =>
        !changed.some(window => range.from <= window.to && range.to >= window.from)
        && !found.some(item => range.from < item.to && range.to > item.from));
    const result: CharRange[] = [];
    let i = 0, j = 0;
    while (i < retained.length || j < found.length) {
        const range = j === found.length || (i < retained.length && retained[i].from <= found[j].from)
            ? retained[i++] : found[j++];
        const last = result[result.length - 1];
        if (!last || range.from >= last.to) result.push(range);
    }
    return result;
}

function updateAnalysis(previous: DocAnalysis, tr: Transaction): DocAnalysis {
    const state = tr.state, tree = syntaxTree(state);
    if (!tr.docChanged && tree === previous.tree) return previous;
    if (!incrementalEditorEnabled()) {
        const full = analyzeDocFull(state), rev = previous.rev + 1;
        const whole = [{ from: 0, to: state.doc.length }];
        full.rev = rev;
        full.delta = { forRev: rev, changed: whole, treeChanged: whole };
        return full;
    }
    const treeChanged = treeDelta(previous.tree, tree, tr.changes, state.doc, tr.startState.doc);
    const codeRanges = updateCodeRanges(previous.codeRanges, tree, tr, treeChanged);
    const lines = tr.docChanged ? updateLineScans(previous.lines, tr.changes, tr.startState.doc, state.doc) : previous.lines;
    const rev = previous.rev + 1;
    const invalidated: CharRange[] = [];
    const difference = <T extends CharRange>(oldItems: readonly T[], newItems: readonly T[], keyOf: (item: T) => string) => {
        const old = new Map<string, CharRange>();
        for (const item of oldItems) {
            const from = tr.changes.mapPos(item.from, 1), to = Math.max(from, tr.changes.mapPos(item.to, -1));
            old.set(`${from}:${to}:${keyOf(item)}`, { from: Math.max(0, from - (from === to ? 1 : 0)), to: Math.min(state.doc.length, to + (from === to ? 1 : 0)) });
        }
        for (const item of newItems) {
            const key = `${item.from}:${item.to}:${keyOf(item)}`;
            if (old.has(key)) old.delete(key); else invalidated.push(item);
        }
        invalidated.push(...old.values());
    };
    difference(previous.codeRanges, codeRanges, () => '');
    const pairs = updateBlockPairs(previous.blockPairs, tr.startState.doc, state.doc, tr.changes,
        lines.mathTokens, codeRanges, mergeAnalysisRanges(invalidated));
    difference(previous.blockPairs, pairs, item => `${item.accepted}:${item.latex}`);
    const inlineRaw = updateInlineMath(lines.inline, previous.inlineRaw, tr.changes, codeRanges, pairs,
        mergeAnalysisRanges(invalidated));
    difference(previous.mathRegions, acceptedMath(pairs, inlineRaw), item => `${item.block}:${item.latex}`);
    const dirtyFilters = mergeAnalysisRanges([...invalidated, ...treeChanged]);
    const result = makeAnalysis(state, tree, rev, codeRanges, lines, pairs, null,
        { previous, transaction: tr, inlineRaw, dirty: dirtyFilters });
    const dirty = [...treeChanged];
    const compare = <T extends CharRange>(before: readonly T[], after: readonly T[], value: (item: T) => string) => {
        const old = new Map<string, CharRange>();
        for (const item of before) {
            const from = tr.changes.mapPos(item.from, 1);
            const range = { from, to: Math.max(from, tr.changes.mapPos(item.to, -1)) };
            old.set(`${range.from}:${range.to}:${value(item)}`, range);
        }
        for (const item of after) {
            const key = `${item.from}:${item.to}:${value(item)}`;
            if (old.has(key)) old.delete(key); else dirty.push(item);
        }
        dirty.push(...old.values());
    };
    compare(previous.codeRanges, result.codeRanges, () => '');
    compare(previous.mathRegions, result.mathRegions, item => `${item.block}:${item.latex}`);
    compare(previous.dollarRuns ?? [], result.dollarRuns ?? [], item => `${item.accepted}:${item.groups.join('\0')}`);
    compare(previous.highlights ?? [], result.highlights ?? [], item => `${item.accepted}:${item.groups.join('\0')}`);
    compare(previous.wikilinks ?? [], result.wikilinks ?? [], item => `${item.accepted}:${item.groups.join('\0')}`);
    compare(previous.objects.embeds, result.objects.embeds, item => `${item.accepted}:${item.filename}:${item.width}`);
    compare(previous.objects.tables, result.objects.tables, item => `${item.accepted}`);
    result.delta = { forRev: rev, changed: mergeAnalysisRanges(dirty), treeChanged };
    return result;
}

export const docAnalysisField = StateField.define<DocAnalysis>({
    create: analyzeDocFull,
    update: updateAnalysis,
});
