import type { PageDisplayList, PathCommand, Rgba } from '../../platform/types';
import { columnOffsets, marginX, paperPageSize, ruleOffsets, type NotebookPaper } from '../../utils/paper';

export const PAPER_WHITE: Rgba = [1, 1, 1, 1];
export const PAPER_RULE: Rgba = [195 / 255, 211 / 255, 232 / 255, 1];
export const PAPER_MARGIN: Rgba = [233 / 255, 184 / 255, 189 / 255, 1];
export const PAPER_EDGE: Rgba = [226 / 255, 226 / 255, 226 / 255, 1];
export const PAPER_RULE_WIDTH = 0.75, PAPER_MARGIN_WIDTH = 1, PAPER_EDGE_WIDTH = 0.5;
const WHITE = PAPER_WHITE, RULE = PAPER_RULE, MARGIN = PAPER_MARGIN, EDGE = PAPER_EDGE;
type PaperItem = PageDisplayList['items'][number];

export function* notebookPaperItems(paper: Readonly<NotebookPaper>): Generator<PaperItem> {
    const { width, height } = paperPageSize(paper);
    yield { kind: 'path', d: [['M', 0, 0], ['L', width, 0], ['L', width, height], ['L', 0, height], ['Z']], fill: WHITE };
    const rules: PathCommand[] = [];
    const line = (x1: number, y1: number, x2: number, y2: number) => {
        rules.push(['M', x1, y1], ['L', x2, y2]);
    };
    if (paper.ruling === 'lined' || paper.ruling === 'grid') {
        for (const y of ruleOffsets(paper)) line(0, y, width, y);
        if (paper.ruling === 'grid') for (const x of columnOffsets(paper)) line(x, 0, x, height);
        yield { kind: 'path', d: rules, stroke: { color: RULE, width: PAPER_RULE_WIDTH, cap: 'butt', join: 'miter' } };
    } else if (paper.ruling === 'dotted') {
        const r = 1.1, k = r * 0.5522847498307936;
        for (const y of ruleOffsets(paper)) {
            const dots: PathCommand[] = [];
            for (const x of columnOffsets(paper)) {
                dots.push(['M', x + r, y], ['C', x + r, y + k, x + k, y + r, x, y + r],
                    ['C', x - k, y + r, x - r, y + k, x - r, y],
                    ['C', x - r, y - k, x - k, y - r, x, y - r],
                    ['C', x + k, y - r, x + r, y - k, x + r, y], ['Z']);
            }
            yield { kind: 'path', d: dots, fill: RULE };
        }
    }
    const margin = marginX(paper);
    if (margin !== null) yield { kind: 'path', d: [['M', margin, 0], ['L', margin, height]],
        stroke: { color: MARGIN, width: PAPER_MARGIN_WIDTH, cap: 'butt', join: 'miter' } };
    const e = PAPER_EDGE_WIDTH / 2;
    yield { kind: 'path', d: [['M', e, e], ['L', width - e, e],
        ['L', width - e, height - e], ['L', e, height - e], ['Z']],
    stroke: { color: EDGE, width: PAPER_EDGE_WIDTH, cap: 'butt', join: 'miter' } };
}

export function notebookPaperList(paper: Readonly<NotebookPaper>, page: number): PageDisplayList {
    return { page, items: [...notebookPaperItems(paper)] };
}
