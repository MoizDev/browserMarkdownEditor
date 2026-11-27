import { createElement } from 'react';
import type { IconNode } from '../utils/entryStyle';

const LUCIDE_DEFAULTS = {
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 2,
    strokeLinecap: 'round',
    strokeLinejoin: 'round',
} as const;

function reactAttrs(attrs: Record<string, string | number>): Record<string, string | number> {
    const out: Record<string, string | number> = {};
    for (const [key, value] of Object.entries(attrs)) {
        out[key.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase())] = value;
    }
    return out;
}

export default function LucideGlyph({ nodes, size = 14 }: { nodes: IconNode[]; size?: number }) {
    return (
        <svg width={size} height={size} {...LUCIDE_DEFAULTS} aria-hidden="true">
            {nodes.map(([tag, attrs], i) => createElement(tag, { key: i, ...reactAttrs(attrs) }))}
        </svg>
    );
}
