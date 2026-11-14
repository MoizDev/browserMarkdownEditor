import type { PageDisplayList, PathCommand, Rgba } from '../../platform/types';
import { columnOffsets, marginX, paperPageSize, ruleOffsets, type NotebookPaper } from '../../utils/paper';

const WHITE: Rgba = [1, 1, 1, 1];
const RULE: Rgba = [195 / 255, 211 / 255, 232 / 255, 1];
const MARGIN: Rgba = [233 / 255, 184 / 255, 189 / 255, 1];
const EDGE: Rgba = [226 / 255, 226 / 255, 226 / 255, 1];

/** One physical page in point units. The same list can feed display and PDF output. */
export function notebookPaperList(paper: Readonly<NotebookPaper>, page: number): PageDisplayList {
    const { width, height } = paperPageSize(paper);
    const items: PageDisplayList['items'] = [];
    items.push({ kind: 'path', d: [['M', 0, 0], ['L', width, 0], ['L', width, height], ['L', 0, height], ['Z']], fill: WHITE });
    const rules: PathCommand[] = [];
    const line = (x1: number, y1: number, x2: number, y2: number) => {
        rules.push(['M', x1, y1], ['L', x2, y2]);
    };
    if (paper.ruling === 'lined' || paper.ruling === 'grid') {
        for (const y of ruleOffsets(paper)) line(0, y, width, y);
        if (paper.ruling === 'grid') for (const x of columnOffsets(paper)) line(x, 0, x, height);
        items.push({ kind: 'path', d: rules, stroke: { color: RULE, width: 0.75, cap: 'butt', join: 'miter' } });
    } else if (paper.ruling === 'dotted') {
        // Four cubics reproduce a circle without requiring a writer-specific primitive.
        const r = 1.1, k = r * 0.5522847498307936;
        for (const y of ruleOffsets(paper)) for (const x of columnOffsets(paper)) {
            rules.push(['M', x + r, y], ['C', x + r, y + k, x + k, y + r, x, y + r],
                ['C', x - k, y + r, x - r, y + k, x - r, y],
                ['C', x - r, y - k, x - k, y - r, x, y - r],
                ['C', x + k, y - r, x + r, y - k, x + r, y], ['Z']);
        }
        items.push({ kind: 'path', d: rules, fill: RULE });
    }
    const margin = marginX(paper);
    if (margin !== null) items.push({ kind: 'path', d: [['M', margin, 0], ['L', margin, height]],
        stroke: { color: MARGIN, width: 1, cap: 'butt', join: 'miter' } });
    items.push({ kind: 'path', d: [['M', 0.25, 0.25], ['L', width - 0.25, 0.25],
        ['L', width - 0.25, height - 0.25], ['L', 0.25, height - 0.25], ['Z']],
    stroke: { color: EDGE, width: 0.5, cap: 'butt', join: 'miter' } });
    return { page, items };
}
