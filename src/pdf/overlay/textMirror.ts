import type { Rect } from '../../platform/types';
import './textMirror.css';

export interface MirrorLine {
    from: number;
    to: number;
    box: Rect;
    direction: 'ltr' | 'rtl' | 'vertical';
    headingLevel?: 1 | 2 | 3 | 4 | 5 | 6;
}
export interface MirrorFigure { box: Rect; alt: string }
export interface MirrorPageText { text: string; lines: readonly MirrorLine[]; figures?: readonly MirrorFigure[] }
export interface MirrorPosition { page: number; offset: number }
export interface MirrorSelection { anchor: MirrorPosition; focus: MirrorPosition }
export interface TextMirrorOptions {
    fileName: string;
    pageCount: number;
    /** Page-local sections are positioned in the same world frame as the page compositor. */
    pageBox: (page: number) => Rect;
    /** Must request geometry at priority 0, bring the page into view, and load its text window. */
    focusPage: (page: number) => void;
    selectionChanged: (selection: MirrorSelection) => void;
    openTextView: () => void;
}

function place(element: HTMLElement, box: Rect): void {
    element.style.left = `${box.x}px`;
    element.style.top = `${box.y}px`;
    element.style.width = `${box.width}px`;
    element.style.height = `${box.height}px`;
}

/** DOM is an accessibility projection, never the source of canonical text or selection. */
export class PdfTextMirror {
    readonly element: HTMLDivElement;
    private readonly sections: HTMLElement[] = [];
    private readonly populated = new Set<number>();
    private readonly rendered = new Map<number, MirrorPageText>();
    private readonly live: HTMLDivElement;
    private announceTimer: ReturnType<typeof setTimeout> | undefined;
    private expectedSelection: MirrorSelection | null = null;
    private readonly onFocus: (event: FocusEvent) => void;
    private readonly onSelection: () => void;

    constructor(private readonly options: TextMirrorOptions) {
        const root = document.createElement('div');
        root.setAttribute('role', 'document');
        root.setAttribute('aria-label', options.fileName);
        root.style.position = 'absolute';
        root.style.inset = '0';
        root.style.pointerEvents = 'none';
        this.element = root;

        const skip = document.createElement('button');
        skip.type = 'button';
        skip.textContent = 'Read this PDF as text';
        skip.className = 'pdf-mirror-skip';
        skip.style.pointerEvents = 'auto';
        skip.addEventListener('click', options.openTextView);
        root.append(skip);
        this.live = document.createElement('div');
        this.live.setAttribute('aria-live', 'polite');
        this.live.className = 'pdf-mirror-live';
        root.append(this.live);

        for (let page = 0; page < options.pageCount; page++) {
            const section = document.createElement('section');
            section.setAttribute('role', 'region');
            section.setAttribute('aria-label', `Page ${page + 1} of ${options.pageCount}`);
            section.tabIndex = -1;
            section.dataset.page = String(page);
            section.className = 'pdf-mirror-page';
            section.style.position = 'absolute';
            section.style.contentVisibility = 'auto';
            this.sections.push(section);
            root.append(section);
            this.setPageBox(page, options.pageBox(page));
            this.placeholder(page);
        }
        this.onFocus = event => {
            const target = event.target;
            if (!(target instanceof Element)) return;
            const section = target.closest<HTMLElement>('.pdf-mirror-page');
            if (!section || !root.contains(section)) return;
            options.focusPage(Number(section.dataset.page));
        };
        this.onSelection = () => {
            const selection = document.getSelection();
            if (!selection || !selection.anchorNode || !selection.focusNode) return;
            const anchor = this.positionFromDom(selection.anchorNode, selection.anchorOffset);
            const focus = this.positionFromDom(selection.focusNode, selection.focusOffset);
            if (!anchor || !focus) return;
            const expected = this.expectedSelection;
            this.expectedSelection = null;
            if (expected && expected.anchor.page === anchor.page && expected.anchor.offset === anchor.offset &&
                expected.focus.page === focus.page && expected.focus.offset === focus.offset) return;
            options.selectionChanged({ anchor, focus });
        };
        root.addEventListener('focusin', this.onFocus);
        document.addEventListener('selectionchange', this.onSelection);
    }

    setPageBox(page: number, box: Rect): void {
        const section = this.sections[page];
        if (!section) return;
        place(section, box);
        section.style.containIntrinsicSize = `${box.width}px ${box.height}px`;
    }

    /** Only the visible window and its one-page margin are retained. */
    setWindow(pages: ReadonlyMap<number, MirrorPageText>): void {
        for (const page of this.populated) if (!pages.has(page)) this.placeholder(page);
        for (const [page, text] of pages) if (this.rendered.get(page) !== text) this.setPageText(page, text);
    }

    private placeholder(page: number): void {
        const section = this.sections[page];
        if (!section) return;
        const p = document.createElement('p');
        p.textContent = `Page ${page + 1}. Move here to read it.`;
        p.style.color = 'transparent';
        section.replaceChildren(p);
        this.populated.delete(page);
        this.rendered.delete(page);
    }

    private setPageText(page: number, data: MirrorPageText): void {
        const section = this.sections[page];
        if (!section) return;
        const fragment = document.createDocumentFragment();
        for (const line of data.lines) {
            if (!Number.isInteger(line.from) || !Number.isInteger(line.to) || line.from < 0 || line.to < line.from || line.to > data.text.length) continue;
            const node = document.createElement('div');
            node.className = 'pdf-mirror-line';
            node.dataset.from = String(line.from);
            node.dataset.to = String(line.to);
            node.style.position = 'absolute';
            node.style.color = 'transparent';
            node.style.whiteSpace = 'pre';
            node.style.overflow = 'clip';
            node.style.pointerEvents = 'none';
            if (line.direction === 'rtl') node.dir = 'rtl';
            if (line.direction === 'vertical') node.style.writingMode = 'vertical-rl';
            if (line.headingLevel) {
                node.setAttribute('role', 'heading');
                node.setAttribute('aria-level', String(line.headingLevel));
            }
            place(node, line.box);
            node.textContent = data.text.slice(line.from, line.to);
            fragment.append(node);
        }
        for (const figure of data.figures ?? []) {
            const node = document.createElement('div');
            node.setAttribute('role', 'img');
            node.setAttribute('aria-label', figure.alt);
            node.style.position = 'absolute';
            place(node, figure.box);
            fragment.append(node);
        }
        section.replaceChildren(fragment);
        this.populated.add(page);
        this.rendered.set(page, data);
    }

    private positionFromDom(node: Node, offset: number): MirrorPosition | null {
        const element = node.nodeType === Node.ELEMENT_NODE ? node as Element : node.parentElement;
        const line = element?.closest<HTMLElement>('.pdf-mirror-line');
        const section = line?.closest<HTMLElement>('.pdf-mirror-page');
        if (!line || !section || !this.element.contains(section)) return null;
        const from = Number(line.dataset.from), to = Number(line.dataset.to), page = Number(section.dataset.page);
        const within = node.nodeType === Node.TEXT_NODE ? offset : offset ? line.textContent?.length ?? 0 : 0;
        return { page, offset: Math.min(to, from + within) };
    }

    /** Returns false when either endpoint is outside the currently mirrored window. */
    setSelection(selection: MirrorSelection): boolean {
        const point = (position: MirrorPosition): [Node, number] | null => {
            const section = this.sections[position.page];
            if (!section || !this.populated.has(position.page)) return null;
            for (const child of section.children) {
                const line = child as HTMLElement;
                if (!line.classList.contains('pdf-mirror-line')) continue;
                const from = Number(line.dataset.from), to = Number(line.dataset.to);
                if (position.offset >= from && position.offset <= to && line.firstChild) return [line.firstChild, position.offset - from];
            }
            return null;
        };
        const a = point(selection.anchor), f = point(selection.focus), dom = document.getSelection();
        if (!a || !f || !dom) return false;
        this.expectedSelection = selection;
        dom.setBaseAndExtent(a[0], a[1], f[0], f[1]);
        return true;
    }

    announcePage(page: number): void {
        clearTimeout(this.announceTimer);
        this.announceTimer = setTimeout(() => { this.live.textContent = `Page ${page + 1} of ${this.options.pageCount}`; }, 500);
    }

    destroy(): void {
        clearTimeout(this.announceTimer);
        this.element.removeEventListener('focusin', this.onFocus);
        document.removeEventListener('selectionchange', this.onSelection);
        this.element.remove();
    }
}
