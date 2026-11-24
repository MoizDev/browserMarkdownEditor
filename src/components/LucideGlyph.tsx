import { createElement } from 'react';
import type { IconNode } from '../utils/entryStyle';

/** Lucide's own drawing contract. Every icon is authored on a 24x24 grid with
 *  these stroke settings; the node data carries only the geometry. */
const LUCIDE_DEFAULTS = {
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 2,
    strokeLinecap: 'round',
    strokeLinejoin: 'round',
} as const;

/** Attributes are `stroke-width` in the data and `strokeWidth` in React. */
function reactAttrs(attrs: Record<string, string | number>): Record<string, string | number> {
    const out: Record<string, string | number> = {};
    for (const [key, value] of Object.entries(attrs)) {
        out[key.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase())] = value;
    }
    return out;
}

/**
 * One Lucide icon, drawn from its node data rather than from the library.
 *
 * The data comes from wherever the caller has it — the picker has just loaded
 * the whole set, while a file-tree row reads it out of `.folders.json`. That is
 * the point: the tree renders its icons with the icon library nowhere in the
 * bundle. See utils/lucideIcons.ts.
 */
export default function LucideGlyph({ nodes, size = 14 }: { nodes: IconNode[]; size?: number }) {
    return (
        <svg width={size} height={size} {...LUCIDE_DEFAULTS} aria-hidden="true">
            {nodes.map(([tag, attrs], i) => createElement(tag, { key: i, ...reactAttrs(attrs) }))}
        </svg>
    );
}
