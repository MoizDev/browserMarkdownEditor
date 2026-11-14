import { StateField } from '@codemirror/state';
import type { EditorState, Transaction } from '@codemirror/state';
import { syntaxTree } from '@codemirror/language';
import type { Tree } from '@lezer/common';
import { docString } from './docCache';
import { scanAllLines, updateLineScans } from './analysisLines';
import type { LineScans } from './analysisLines';
import { acceptedMath, filterInlineMath, pairMathTokens, updateBlockPairs } from './analysisMath';
import type { BlockPair, InlineMath } from './analysisMath';
import { mergeAnalysisRanges, treeDelta } from './analysisTree';
import { codeRangesForTree } from '../utils/mathRegions';
import type { MathRegion } from '../utils/mathRegions';
import type { CharRange } from '../utils/rangeSearch';

export interface AnalysisDelta {
    forRev: number;
    changed: CharRange[];
    treeChanged: CharRange[];
}

export interface DocAnalysis {
    rev: number;
    treeLength: number;
    tree: Tree;
    /** Transitional access for consumers not yet switched to source slices. */
    readonly doc: string;
    codeRanges: CharRange[];
    mathRegions: MathRegion[];
    mathEnds: number[];
    lines: LineScans;
    blockPairs: BlockPair[];
    inlineRaw: InlineMath[];
    delta: AnalysisDelta | null;
}

function makeAnalysis(state: EditorState, tree: Tree, rev: number, codeRanges: CharRange[],
    lines: LineScans, blockPairs: BlockPair[], delta: AnalysisDelta | null): DocAnalysis {
    const inlineRaw = filterInlineMath(lines.inline, codeRanges, blockPairs);
    const mathRegions = acceptedMath(blockPairs, inlineRaw);
    return { rev, treeLength: tree.length, tree, get doc() { return docString(state.doc); },
        codeRanges, mathRegions, mathEnds: mathRegions.map(region => region.to), lines, blockPairs,
        inlineRaw, delta };
}

export function analyzeDocFull(state: EditorState): DocAnalysis {
    const tree = syntaxTree(state), codeRanges = codeRangesForTree(tree);
    const lines = scanAllLines(state.doc);
    const pairs = pairMathTokens(state.doc, lines.mathTokens, codeRanges);
    return makeAnalysis(state, tree, 0, codeRanges, lines, pairs, null);
}

function updateAnalysis(previous: DocAnalysis, tr: Transaction): DocAnalysis {
    const state = tr.state, tree = syntaxTree(state);
    if (!tr.docChanged && tree === previous.tree) return previous;
    const treeChanged = treeDelta(previous.tree, tree, tr.changes, state.doc);
    const codeRanges = codeRangesForTree(tree);
    const lines = tr.docChanged ? updateLineScans(previous.lines, tr.changes, tr.startState.doc, state.doc) : previous.lines;
    const pairs = updateBlockPairs(previous.blockPairs, tr.startState.doc, state.doc, tr.changes, lines.mathTokens, codeRanges);
    const rev = previous.rev + 1;
    const result = makeAnalysis(state, tree, rev, codeRanges, lines, pairs, null);
    const dirty = [...treeChanged];
    const compare = <T extends CharRange>(before: readonly T[], after: readonly T[], value: (item: T) => string) => {
        const old = new Map<string, CharRange>();
        for (const item of before) {
            const range = { from: tr.changes.mapPos(item.from, 1), to: tr.changes.mapPos(item.to, -1) };
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
    compare(previous.lines.dollars, lines.dollars, item => item.groups.join('\0'));
    compare(previous.lines.highlights, lines.highlights, item => item.groups.join('\0'));
    compare(previous.lines.wikilinks, lines.wikilinks, item => item.groups.join('\0'));
    result.delta = { forRev: rev, changed: mergeAnalysisRanges(dirty), treeChanged };
    return result;
}

export const docAnalysisField = StateField.define<DocAnalysis>({
    create: analyzeDocFull,
    update: updateAnalysis,
});
