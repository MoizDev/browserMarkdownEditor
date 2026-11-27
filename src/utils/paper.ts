export const PAGE_GAP = 24;

export interface PageBox {
    x: number;
    y: number;
    width: number;
    height: number;
}

export function pageLayout(pages: Array<{ width: number; height: number }>): PageBox[] {
    let y = 0;
    return pages.map(p => {
        const box = { x: 0, y, width: p.width, height: p.height };
        y += p.height + PAGE_GAP;
        return box;
    });
}

export const PAPER_SIZES = {
    letter: { width: 612, height: 792, label: 'Letter' },
    a4: { width: 595.28, height: 841.89, label: 'A4' },
    legal: { width: 612, height: 1008, label: 'Legal' },
} as const;

export type PaperSize = keyof typeof PAPER_SIZES;
export type PaperRuling = 'lined' | 'grid' | 'dotted' | 'blank';
export type PaperOrientation = 'portrait' | 'landscape';

export interface NotebookPaper {
    size: PaperSize;
    orientation: PaperOrientation;
    ruling: PaperRuling;
    spacing: number;
    margin: boolean;
    pageCount: number;
}

export const DEFAULT_SPACING = 24;

export const DEFAULT_PAPER: NotebookPaper = {
    size: 'letter',
    orientation: 'portrait',
    ruling: 'lined',
    spacing: DEFAULT_SPACING,
    margin: true,
    pageCount: 1,
};

const MARGIN_INSET = 72;

const RULE_INSET = 48;

export function paperPageSize(paper: NotebookPaper): { width: number; height: number } {
    const { width, height } = Object.hasOwn(PAPER_SIZES, paper.size) ? PAPER_SIZES[paper.size] : PAPER_SIZES.letter;
    return paper.orientation === 'landscape'
        ? { width: height, height: width }
        : { width, height };
}

/** Clamp a paper record read off disk: a `.notebook` file is user-editable text
 *  and a bad `spacing` would otherwise loop forever building rules. */
export function normalizePaper(raw: Partial<NotebookPaper> | undefined): NotebookPaper {
    const size: PaperSize = typeof raw?.size === 'string' && Object.hasOwn(PAPER_SIZES, raw.size)
        ? raw.size
        : DEFAULT_PAPER.size;
    const ruling: PaperRuling = raw?.ruling && ['lined', 'grid', 'dotted', 'blank'].includes(raw.ruling)
        ? raw.ruling
        : DEFAULT_PAPER.ruling;
    const spacing = Number(raw?.spacing);
    return {
        size,
        orientation: raw?.orientation === 'landscape' ? 'landscape' : 'portrait',
        ruling,
        spacing: Number.isFinite(spacing) ? Math.min(200, Math.max(8, spacing)) : DEFAULT_SPACING,
        margin: raw?.margin !== false,
        pageCount: Math.min(MAX_PAGES, Math.max(1, Math.round(Number(raw?.pageCount)) || 1)),
    };
}

export const MAX_PAGES = 500;

export function ruleOffsets(paper: NotebookPaper): number[] {
    const { height } = paperPageSize(paper);
    const lines: number[] = [];
    for (let y = RULE_INSET; y <= height - RULE_INSET; y += paper.spacing) lines.push(y);
    return lines;
}

export function columnOffsets(paper: NotebookPaper): number[] {
    const { width } = paperPageSize(paper);
    const lines: number[] = [];
    for (let x = paper.spacing; x <= width - paper.spacing / 2; x += paper.spacing) lines.push(x);
    return lines;
}

export function marginX(paper: NotebookPaper): number | null {
    return paper.ruling === 'lined' && paper.margin ? MARGIN_INSET : null;
}
