import { syntaxTree } from '@codemirror/language';
import type { EditorSelection, EditorState, Transaction } from '@codemirror/state';
import type { DocAnalysis } from './docAnalysis';
import { parseListMarker } from './lists';
import { firstRangeEndingAfter, type CharRange } from '../utils/rangeSearch';

export interface PreviewWindow { from: number; to: number }

function overlaps(selection: EditorSelection, from: number, to: number): boolean {
    return selection.ranges.some(range => range.from <= to && range.to >= from);
}
function onLines(state: EditorState, selection: EditorSelection, from: number, to: number): boolean {
    const a = state.doc.lineAt(from).number, b = state.doc.lineAt(to).number;
    return selection.ranges.some(range => { const n = state.doc.lineAt(range.head).number; return n >= a && n <= b; });
}
function inside(selection: EditorSelection, from: number, to: number): boolean {
    return selection.ranges.some(range => range.empty && range.from > from && range.from < to);
}
function exact(selection: EditorSelection, from: number, to: number): boolean {
    return selection.main.from === from && selection.main.to === to;
}
function merge(ranges: PreviewWindow[]): PreviewWindow[] {
    ranges.sort((a, b) => a.from - b.from || a.to - b.to);
    const result: PreviewWindow[] = [];
    for (const range of ranges) {
        const last = result[result.length - 1];
        if (last && range.from <= last.to) last.to = Math.max(last.to, range.to);
        else result.push({ ...range });
    }
    return result;
}
function symmetricCoverage(a: EditorSelection, b: EditorSelection): PreviewWindow[] {
    const points: { pos: number; side: number; delta: number }[] = [];
    for (const [side, sel] of [[0, a], [1, b]] as const) for (const r of sel.ranges) {
        points.push({ pos: r.from, side, delta: 1 }, { pos: r.to + 1, side, delta: -1 });
    }
    points.sort((x, y) => x.pos - y.pos);
    const result: PreviewWindow[] = [], counts = [0, 0];
    let previous = points[0]?.pos ?? 0, i = 0;
    while (i < points.length) {
        const pos = points[i].pos;
        if (pos > previous && !!counts[0] !== !!counts[1]) result.push({ from: previous, to: pos });
        while (i < points.length && points[i].pos === pos) { counts[points[i].side] += points[i].delta; i++; }
        previous = pos;
    }
    return result;
}
function candidates<T extends CharRange>(items: readonly T[], intervals: readonly PreviewWindow[], visit: (item: T) => void): void {
    for (const interval of intervals) {
        for (let i = firstRangeEndingAfter(items, Math.max(0, interval.from - 1)); i < items.length && items[i].from < interval.to; i++) visit(items[i]);
    }
}

/** New-coordinate, whole-line windows. A failed revision check is handled by the caller. */
export function planPreviewWindows(tr: Transaction, analysis: DocAnalysis, edit: boolean, analysisChanged: boolean): PreviewWindow[] {
    const state = tr.state, doc = state.doc;
    const dirty: PreviewWindow[] = analysisChanged ? [...(analysis.delta?.changed ?? []), ...(analysis.delta?.treeChanged ?? [])] : [];
    if (edit && !tr.startState.selection.map(tr.changes).eq(state.selection)) {
        const before = tr.startState.selection.map(tr.changes), after = state.selection;
        const ranges = symmetricCoverage(before, after);
        const headLines = new Set<number>();
        for (const r of [...before.ranges, ...after.ranges]) headLines.add(doc.lineAt(r.head).number);
        const touched = merge([...ranges, ...[...headLines].map(number => {
            const line = doc.line(number); return { from: line.from, to: line.to + 1 };
        })]);
        for (const interval of touched) syntaxTree(state).iterate({ from: interval.from, to: Math.min(doc.length, interval.to), enter(node) {
            const { name, from, to } = node;
            if (name === 'Emphasis' || name === 'StrongEmphasis' || name === 'Strikethrough' || name === 'InlineCode' || name === 'Link' || name === 'Autolink') {
                if (overlaps(before, from, to) !== overlaps(after, from, to)) dirty.push({ from, to });
            } else if (/^ATXHeading[1-6]$/.test(name) || name === 'FencedCode' || name === 'Blockquote' || name === 'ListItem' || name === 'HorizontalRule') {
                let ownTo = to;
                if (name === 'ListItem') {
                    const line = doc.lineAt(from);
                    for (let child = node.node.firstChild; child; child = child.nextSibling) {
                        if (child.name === 'BulletList' || child.name === 'OrderedList') {
                            const sub = doc.lineAt(child.from).number;
                            ownTo = sub > line.number ? doc.line(sub - 1).to : line.to;
                            break;
                        }
                    }
                    const ws = parseListMarker(line.text)?.ws.length ?? 0;
                    if (ws && overlaps(before, line.from, line.from + ws) !== overlaps(after, line.from, line.from + ws)) dirty.push({ from: line.from, to: line.to });
                }
                if (onLines(state, before, from, ownTo) !== onLines(state, after, from, ownTo)) {
                    if (name === 'FencedCode') {
                        const start = doc.lineAt(from), end = doc.lineAt(to);
                        if (/^(?:\s|>)*(?:`{3,}|~{3,})\s*mermaid(?:\s|$)/i.test(start.text)) dirty.push({ from, to });
                        else { dirty.push({ from: start.from, to: start.to }); dirty.push({ from: end.from, to: end.to }); }
                    } else dirty.push({ from, to: ownTo });
                }
            }
        } });
        for (const items of [analysis.mathRegions, analysis.lines.highlights, analysis.lines.wikilinks]) {
            candidates<CharRange>(items, ranges, item => { if (overlaps(before, item.from, item.to) !== overlaps(after, item.from, item.to)) dirty.push(item); });
        }
        const objectCandidates = [...touched, { from: before.main.from, to: before.main.to + 1 }, { from: after.main.from, to: after.main.to + 1 }];
        candidates(analysis.objects.embeds, objectCandidates, item => {
            if (inside(before, item.from, item.to) !== inside(after, item.from, item.to) || exact(before, item.from, item.to) !== exact(after, item.from, item.to)) dirty.push(item);
        });
        candidates(analysis.objects.tables, objectCandidates, item => {
            if (exact(before, item.from, item.to) !== exact(after, item.from, item.to)) dirty.push(item);
        });
    }
    // A changed leaf is the smallest unit in which inline syntax can nest.
    const widened: PreviewWindow[] = [];
    for (const range of dirty) {
        let from = Math.max(0, Math.min(doc.length, range.from)), to = Math.max(0, Math.min(doc.length, range.to));
        syntaxTree(state).iterate({ from, to: Math.max(from, to), enter(node) {
            if (/^(Paragraph|ATXHeading[1-6]|SetextHeading[12]|ThematicBreak|HTMLBlock|LinkReference)$/.test(node.name)) {
                from = Math.min(from, node.from); to = Math.max(to, node.to);
            }
        } });
        for (const items of [analysis.mathRegions, analysis.objects.embeds, analysis.objects.tables]) {
            candidates<CharRange>(items, [{ from, to: to + 1 }], item => { from = Math.min(from, item.from); to = Math.max(to, item.to); });
        }
        const start = doc.lineAt(from), end = doc.lineAt(to);
        widened.push({ from: start.from, to: end.number < doc.lines ? doc.line(end.number + 1).from : doc.length + 1 });
    }
    return merge(widened);
}
