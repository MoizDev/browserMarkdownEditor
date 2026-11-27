import { Decoration, EditorView, keymap } from '@codemirror/view';
import { EditorSelection, Prec } from '@codemirror/state';
import type { EditorState, Extension, Range, Text } from '@codemirror/state';
import { syntaxTree } from '@codemirror/language';
import { analyzeDocFull, docAnalysisField } from './docAnalysis';
import type { DocAnalysis } from './docAnalysis';
export type { DocAnalysis } from './docAnalysis';
import { straddlesPoint } from '../utils/rangeSearch';
import type { CharRange } from '../utils/rangeSearch';
import { codeRangesForTree } from '../utils/mathRegions';
export { findMathRegions } from '../utils/mathRegions';
export type { MathRegion } from '../utils/mathRegions';

export function collectCodeRanges(state: EditorState): CharRange[] {
    return codeRangesForTree(syntaxTree(state));
}

const memo = new WeakMap<Text, { tree: unknown; value: DocAnalysis }>();
export function analyzeDoc(state: EditorState): DocAnalysis {
    const current = state.field(docAnalysisField, false);
    if (current) return current;
    const tree = syntaxTree(state), hit = memo.get(state.doc);
    if (hit && hit.tree === tree) return hit.value;
    const value = analyzeDocFull(state);
    memo.set(state.doc, { tree, value });
    return value;
}

export function firstMathFrom(analysis: DocAnalysis, from: number): number {
    const ends = analysis.mathEnds;
    let lo = 0, hi = ends.length;
    while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (ends[mid] <= from) lo = mid + 1;
        else hi = mid;
    }
    return lo;
}

export function mathSkipsRange(analysis: DocAnalysis, from: number, to: number): boolean {
    const start = analysis.mathRegions[firstMathFrom(analysis, from)];
    if (start && start.from < from) return true;
    const end = analysis.mathRegions[firstMathFrom(analysis, to)];
    return !!end && end.from < to;
}

export function overlapsMath(analysis: DocAnalysis, from: number, to: number): boolean {
    const i = firstMathFrom(analysis, from);
    return i < analysis.mathRegions.length && analysis.mathRegions[i].from < to;
}

const TOKEN_RE = new RegExp(
    '(\\\\(?:[a-zA-Z]+\\*?|.))' +
    '|([0-9]+(?:\\.[0-9]+)?)' +
    '|([\\^_])' +
    '|([{}\\[\\]])' +
    '|([()])' +
    "|([=+\\-*/<>,;:!|&'])" +
    '|(\\$+)' +
    "|([^\\s\\\\0-9^_{}\\[\\]()=+\\-*/<>,;:!|&'$]+)",
    'g'
);

const GROUP_CLASS = [
    '',
    'cm-latex-command',
    'cm-latex-number',
    'cm-latex-script',
    'cm-latex-brace',
    'cm-latex-paren',
    'cm-latex-operator',
    'cm-latex-delim',
    'cm-latex-var',
];

const GROUP_MARK = GROUP_CLASS.map(cls => (cls ? Decoration.mark({ class: cls }) : null));
const MATH_SRC_MARK = Decoration.mark({ class: 'cm-math-src' });

export function isInMathContext(state: EditorState, pos: number): boolean {
    const { mathRegions } = analyzeDoc(state);
    if (straddlesPoint(mathRegions, pos)) return true;
    const line = state.doc.lineAt(pos);
    const dollars = state.sliceDoc(line.from, pos).match(/(?<!\\)\$/g);
    return (dollars?.length ?? 0) % 2 === 1;
}

const BRACKET_PAIRS: Record<string, string> = { '{': '}', '(': ')', '[': ']' };
const CLOSERS = new Set(Object.values(BRACKET_PAIRS));

function inCodeRange(state: EditorState, pos: number): boolean {
    return straddlesPoint(analyzeDoc(state).codeRanges, pos);
}

function handleDollar(view: EditorView, from: number): boolean {
    const { state } = view;
    if (inCodeRange(state, from)) return false;
    if (state.sliceDoc(from - 1, from) === '\\') return false;

    const changes = state.changeByRange((range) => {
        if (!range.empty) {
            return {
                changes: [
                    { from: range.from, insert: '$' },
                    { from: range.to, insert: '$' },
                ],
                range: EditorSelection.range(range.from + 1, range.to + 1),
            };
        }
        const pos = range.from;
        const prev = state.sliceDoc(pos - 1, pos);
        const next = state.sliceDoc(pos, pos + 1);
        const line = state.doc.lineAt(pos);
        const dollarsBefore = state.sliceDoc(line.from, pos).match(/\$/g)?.length ?? 0;

        if (prev === '$' && next === '$' && dollarsBefore === 1) {
            return { changes: { from: pos, insert: '$$' }, range: EditorSelection.cursor(pos + 1) };
        }
        if (next === '$') {
            return { range: EditorSelection.cursor(pos + 1) };
        }
        return { changes: { from: pos, insert: '$$' }, range: EditorSelection.cursor(pos + 1) };
    });
    view.dispatch({ ...changes, userEvent: 'input.type', scrollIntoView: true });
    return true;
}

export function mathEditingExtensions(): Extension {
    return [
        Prec.high(EditorView.inputHandler.of((view, from, _to, text) => {
            if (text === '$') return handleDollar(view, from);
            if (text.length !== 1) return false;
            const isOpen = text in BRACKET_PAIRS;
            if (!isOpen && !CLOSERS.has(text)) return false;
            const { state } = view;
            if (!isInMathContext(state, from)) return false;

            if (!isOpen) {
                if (state.selection.main.empty && state.sliceDoc(from, from + 1) === text) {
                    view.dispatch({ selection: EditorSelection.cursor(from + 1), userEvent: 'input.type' });
                    return true;
                }
                return false;
            }

            const changes = state.changeByRange((range) => range.empty
                ? {
                    changes: { from: range.from, insert: text + BRACKET_PAIRS[text] },
                    range: EditorSelection.cursor(range.from + 1),
                }
                : {
                    changes: [
                        { from: range.from, insert: text },
                        { from: range.to, insert: BRACKET_PAIRS[text] },
                    ],
                    range: EditorSelection.range(range.from + 1, range.to + 1),
                });
            view.dispatch({ ...changes, userEvent: 'input.type', scrollIntoView: true });
            return true;
        })),
        Prec.high(keymap.of([{
            key: 'Backspace',
            run: (view) => {
                const { state } = view;
                const range = state.selection.main;
                if (!range.empty || range.from === 0) return false;
                const pair = state.sliceDoc(range.from - 1, range.from + 1);
                const isPair = pair.length === 2
                    && (BRACKET_PAIRS[pair[0]] === pair[1] || pair === '$$');
                if (!isPair) return false;
                if (inCodeRange(state, range.from)) return false;
                if (pair !== '$$' && !isInMathContext(state, range.from)) return false;
                view.dispatch({
                    changes: { from: range.from - 1, to: range.from + 1 },
                    userEvent: 'delete.backward',
                });
                return true;
            },
        }])),
    ];
}

export function latexSourceDecorations(source: string, offset: number): Range<Decoration>[] {
    const out: Range<Decoration>[] = [];
    out.push(MATH_SRC_MARK.range(offset, offset + source.length));

    TOKEN_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = TOKEN_RE.exec(source)) !== null) {
        for (let g = 1; g < GROUP_MARK.length; g++) {
            if (m[g] !== undefined) {
                out.push(GROUP_MARK[g]!.range(offset + m.index, offset + m.index + m[0].length));
                break;
            }
        }
    }
    return out;
}
