// Pages: how they are laid out on a canvas, and what a ruled one looks like.
//
// Shared by the two canvases that draw ON pages rather than on open space — the
// PDF annotator, whose pages come from a document, and the notebook, whose pages
// are generated here. Both stack them the same way and both hand the same page
// boxes to the export, so the layout has to be one function, not two.
//
// IMPORTS NOTHING, deliberately. `pageLayout` lived in pdfAnnotation.ts, which
// pulls in pdf.js — so a notebook importing it from there would have loaded the
// whole PDF renderer to stack some rectangles. See the module-split rule in the
// pdf-and-drawings skill.

/** Vertical gap between pages on a canvas, in PDF points. */
export const PAGE_GAP = 24;

export interface PageBox {
    x: number;
    y: number;
    width: number;
    height: number;
}

/**
 * Where each page sits: stacked vertically, left-aligned, in point space.
 *
 * Shared by the canvas layout and the save path, so a stroke's canvas position
 * maps back to the correct page and offset.
 */
export function pageLayout(pages: Array<{ width: number; height: number }>): PageBox[] {
    let y = 0;
    return pages.map(p => {
        const box = { x: 0, y, width: p.width, height: p.height };
        y += p.height + PAGE_GAP;
        return box;
    });
}

/* ── Notebook paper ─────────────────────────────────────────────────────── */

export const PAPER_SIZES = {
    letter: { width: 612, height: 792, label: 'Letter' },
    a4: { width: 595.28, height: 841.89, label: 'A4' },
    legal: { width: 612, height: 1008, label: 'Legal' },
} as const;

export type PaperSize = keyof typeof PAPER_SIZES;
export type PaperRuling = 'lined' | 'grid' | 'dotted' | 'blank';
export type PaperOrientation = 'portrait' | 'landscape';

/** A notebook's paper. Persisted verbatim in the `.notebook` file. */
export interface NotebookPaper {
    size: PaperSize;
    orientation: PaperOrientation;
    ruling: PaperRuling;
    /** Distance between rules/squares/dots, in points. */
    spacing: number;
    /** Draw the left margin rule (lined paper only). */
    margin: boolean;
    /** How many pages the notebook currently has. At least 1. */
    pageCount: number;
}

/** ~8.5mm, i.e. wide-ruled — the spacing most handwriting is comfortable at. */
export const DEFAULT_SPACING = 24;

export const DEFAULT_PAPER: NotebookPaper = {
    size: 'letter',
    orientation: 'portrait',
    ruling: 'lined',
    spacing: DEFAULT_SPACING,
    margin: true,
    pageCount: 1,
};

/* Paper colours are FIXED, not themed.
 *
 * A page is paper: it is white here and white in the PDF this notebook exports
 * to, so a dark-mode variant would be a second appearance that the export could
 * not reproduce. The notebook canvas pins itself to tldraw's light scheme for
 * the same reason the PDF annotator does — see NotebookPane. */
export const PAPER_WHITE = '#ffffff';
const RULE_COLOR = '#c3d3e8';
const MARGIN_COLOR = '#e9b8bd';
const EDGE_COLOR = '#e2e2e2';

/** Distance from the left edge to the margin rule: one inch, as on real paper. */
const MARGIN_INSET = 72;

/** Blank space kept clear at the top and bottom before ruling starts. */
const RULE_INSET = 48;

export function paperPageSize(paper: NotebookPaper): { width: number; height: number } {
    const { width, height } = PAPER_SIZES[paper.size] ?? PAPER_SIZES.letter;
    return paper.orientation === 'landscape'
        ? { width: height, height: width }
        : { width, height };
}

/** Clamp a paper record read off disk: a `.notebook` file is user-editable text
 *  and a bad `spacing` would otherwise loop forever building rules. */
export function normalizePaper(raw: Partial<NotebookPaper> | undefined): NotebookPaper {
    const size: PaperSize = raw?.size && raw.size in PAPER_SIZES ? raw.size : DEFAULT_PAPER.size;
    const ruling: PaperRuling = raw?.ruling && ['lined', 'grid', 'dotted', 'blank'].includes(raw.ruling)
        ? raw.ruling
        : DEFAULT_PAPER.ruling;
    const spacing = Number(raw?.spacing);
    return {
        size,
        orientation: raw?.orientation === 'landscape' ? 'landscape' : 'portrait',
        ruling,
        // 8pt is about as tight as a rule can be and still be a rule; 200 is
        // past a page. Anything outside, or not a number at all, takes the default.
        spacing: Number.isFinite(spacing) ? Math.min(200, Math.max(8, spacing)) : DEFAULT_SPACING,
        margin: raw?.margin !== false,
        pageCount: Math.min(MAX_PAGES, Math.max(1, Math.round(Number(raw?.pageCount)) || 1)),
    };
}

/**
 * A ceiling on pages, because pages are appended automatically as you write to
 * the bottom of the last one — so a runaway loop would otherwise be unbounded.
 * 500 Letter pages is a canvas about 113 metres tall.
 */
export const MAX_PAGES = 500;

/** The y offsets of every horizontal rule on a page, top-down. */
export function ruleOffsets(paper: NotebookPaper): number[] {
    const { height } = paperPageSize(paper);
    const lines: number[] = [];
    for (let y = RULE_INSET; y <= height - RULE_INSET; y += paper.spacing) lines.push(y);
    return lines;
}

/** The x offsets of every vertical rule on a grid page, left-to-right. */
export function columnOffsets(paper: NotebookPaper): number[] {
    const { width } = paperPageSize(paper);
    const lines: number[] = [];
    for (let x = paper.spacing; x <= width - paper.spacing / 2; x += paper.spacing) lines.push(x);
    return lines;
}

/** Where the left margin rule sits, or null when this paper has none. */
export function marginX(paper: NotebookPaper): number | null {
    return paper.ruling === 'lined' && paper.margin ? MARGIN_INSET : null;
}

/**
 * One page of this paper as an SVG document.
 *
 * SVG rather than a rasterized image ON PURPOSE, and this is the one place the
 * app can have it: the PDF annotator is stuck rasterizing because pdf.js has no
 * SVG backend, but a notebook's page is drawn here — so the backdrop stays
 * resolution-independent and is still crisp at 800%, with no re-render pass and
 * no per-zoom memory. Every page of a notebook is identical, so ONE of these
 * serves the whole document.
 */
export function paperSvg(paper: NotebookPaper): string {
    const { width, height } = paperPageSize(paper);
    const parts: string[] = [];

    const line = (x1: number, y1: number, x2: number, y2: number, color: string, w = 0.75) =>
        `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${color}" stroke-width="${w}"/>`;

    if (paper.ruling === 'lined' || paper.ruling === 'grid') {
        for (const y of ruleOffsets(paper)) parts.push(line(0, y, width, y, RULE_COLOR));
    }
    if (paper.ruling === 'grid') {
        for (const x of columnOffsets(paper)) parts.push(line(x, 0, x, height, RULE_COLOR));
    }
    if (paper.ruling === 'dotted') {
        for (const y of ruleOffsets(paper)) {
            for (const x of columnOffsets(paper)) {
                parts.push(`<circle cx="${x}" cy="${y}" r="1.1" fill="${RULE_COLOR}"/>`);
            }
        }
    }
    const margin = marginX(paper);
    if (margin !== null) parts.push(line(margin, 0, margin, height, MARGIN_COLOR, 1));

    // A hairline edge so a page reads as a sheet against the canvas rather than
    // bleeding into it. Inset by half its width so it isn't clipped.
    parts.push(`<rect x="0.25" y="0.25" width="${width - 0.5}" height="${height - 0.5}"`
        + ` fill="none" stroke="${EDGE_COLOR}" stroke-width="0.5"/>`);

    return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"`
        + ` viewBox="0 0 ${width} ${height}">`
        + `<rect width="${width}" height="${height}" fill="${PAPER_WHITE}"/>`
        + parts.join('')
        + `</svg>`;
}

/**
 * `paperSvg` as a data: URI, which is what tldraw's asset resolver hands back.
 *
 * encodeURIComponent, not base64: it keeps the markup legible in devtools and
 * is shorter for this content. `#` MUST be escaped or the parser truncates the
 * document at the first colour — which is every colour in the file.
 */
export function paperDataUri(paper: NotebookPaper): string {
    return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(paperSvg(paper))}`;
}
