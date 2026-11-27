const SVG = 'http://www.w3.org/2000/svg';
const stacks = new WeakMap<HTMLElement, HTMLDivElement>();

export function helperStack(overlay: HTMLElement): HTMLDivElement {
    let stack = stacks.get(overlay);
    if (!stack) {
        stack = document.createElement('div');
        stack.className = 'board-helper-stack';
        overlay.append(stack);
        stacks.set(overlay, stack);
    }
    return stack;
}

/** Lucide's arrow-left and x path data (ISC), the navigation panel's family. */
export const helperIconPaths = {
    arrowLeft: ['m12 19-7-7 7-7', 'M19 12H5'],
    close: ['M18 6 6 18', 'm6 6 12 12'],
} as const;

/** A 16px helper icon in currentColor. Built with DOM calls, not markup: this origin's only innerHTML sinks are the two
 * AGENTS.md names. */
export function helperIcon(paths: readonly string[]): SVGSVGElement {
    const svg = document.createElementNS(SVG, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('width', '16'); svg.setAttribute('height', '16');
    svg.setAttribute('fill', 'none'); svg.setAttribute('stroke', 'currentColor'); svg.setAttribute('stroke-width', '2');
    svg.setAttribute('stroke-linecap', 'round'); svg.setAttribute('stroke-linejoin', 'round');
    svg.setAttribute('aria-hidden', 'true'); svg.setAttribute('focusable', 'false');
    for (const d of paths) {
        const path = document.createElementNS(SVG, 'path');
        path.setAttribute('d', d);
        svg.append(path);
    }
    return svg;
}
