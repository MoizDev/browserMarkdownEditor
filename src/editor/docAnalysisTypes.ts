import type { ChangeDesc, Text } from '@codemirror/state';
import type { Tree } from '@lezer/common';
import type { CharRange } from '../utils/rangeSearch';
import type { MathRegion } from '../utils/mathRegions';
import type { LineMatch, LineScans } from './analysisLines';
import type { BlockPair, InlineMath } from './analysisMath';
import type { ObjectScans } from './analysisObjects';

export type { ObjectMatch, EmbedMatch, ObjectScans } from './analysisObjects';
export type { LineMatch, LineScans } from './analysisLines';
export type { BlockPair, InlineMath } from './analysisMath';

export interface FilteredLineMatch extends LineMatch { accepted: boolean }

export interface AnalysisDelta {
    forRev: number;
    changed: CharRange[];
    treeChanged: CharRange[];
}

export interface DocAnalysis {
    rev: number;
    treeLength: number;
    tree: Tree;
    codeRanges: CharRange[];
    mathRegions: MathRegion[];
    mathEnds: number[];
    lines: LineScans;
    dollarRuns: FilteredLineMatch[];
    highlights: FilteredLineMatch[];
    wikilinks: FilteredLineMatch[];
    blockPairs: BlockPair[];
    inlineRaw: InlineMath[];
    objects: ObjectScans;
    delta: AnalysisDelta | null;
}

export type TreeDelta = (oldTree: Tree, newTree: Tree, changes: ChangeDesc, newDoc: Text) => CharRange[];
export type ScanObjects = typeof import('./analysisObjects').scanObjects;
export type UpdateObjects = typeof import('./analysisObjects').updateObjects;
