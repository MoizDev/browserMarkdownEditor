import type { ReactNode } from 'react';

/**
 * The board tool bar's glyphs. Node data is copied verbatim from lucide-static 1.43
 * (node_modules/lucide-static/icons/<kebab-name>.svg), the set the app already ships
 * (see components/icons.tsx), so the bar reads as the same family as the sidebar.
 * Four tools have no Lucide glyph (diamond, oval, rhombus, polyline); those are drawn
 * here on the same 24-unit grid with the same stroke. Never copied from tldraw.
 */
const GLYPHS: Readonly<Record<string, ReactNode>> = {
    select: <path d="M4.037 4.688a.495.495 0 0 1 .651-.651l16 6.5a.5.5 0 0 1-.063.947l-6.124 1.58a2 2 0 0 0-1.438 1.435l-1.579 6.126a.5.5 0 0 1-.947.063z" />,
    hand: <>
        <path d="M18 11V6a2 2 0 0 0-2-2a2 2 0 0 0-2 2" />
        <path d="M14 10V4a2 2 0 0 0-2-2a2 2 0 0 0-2 2v2" />
        <path d="M10 10.5V6a2 2 0 0 0-2-2a2 2 0 0 0-2 2v8" />
        <path d="M18 8a2 2 0 1 1 4 0v6a8 8 0 0 1-8 8h-2c-2.8 0-4.5-.86-5.99-2.34l-3.6-3.6a2 2 0 0 1 2.83-2.82L7 15" />
    </>,
    pen: <>
        <path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z" />
        <path d="m15 5 4 4" />
    </>,
    eraser: <>
        <path d="M21 21H8a2 2 0 0 1-1.42-.587l-3.994-3.999a2 2 0 0 1 0-2.828l10-10a2 2 0 0 1 2.829 0l5.999 6a2 2 0 0 1 0 2.828L12.834 21" />
        <path d="m5.082 11.09 8.828 8.828" />
    </>,
    connector: <>
        <path d="M7 7h10v10" />
        <path d="M7 17 17 7" />
    </>,
    text: <>
        <path d="M12 4v16" />
        <path d="M4 7V5a1 1 0 0 1 1-1h14a1 1 0 0 1 1 1v2" />
        <path d="M9 20h6" />
    </>,
    sticky: <>
        <path d="M21 9a2.4 2.4 0 0 0-.706-1.706l-3.588-3.588A2.4 2.4 0 0 0 15 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2z" />
        <path d="M15 3v5a1 1 0 0 0 1 1h5" />
    </>,
    media: <>
        <circle cx="9" cy="9" r="2" />
        <path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21" />
        <rect width="18" height="18" x="3" y="3" rx="2" />
    </>,
    polyline: <polyline points="3 18 9 8 15 16 21 6" />,
    highlighter: <>
        <path d="m9 11-6 6v3h9l3-3" />
        <path d="m22 12-4.6 4.6a2 2 0 0 1-2.8 0l-5.2-5.2a2 2 0 0 1 0-2.8L14 4" />
    </>,
    laser: <>
        <circle cx="12" cy="12" r="10" />
        <line x1="22" x2="18" y1="12" y2="12" />
        <line x1="6" x2="2" y1="12" y2="12" />
        <line x1="12" x2="12" y1="6" y2="2" />
        <line x1="12" x2="12" y1="22" y2="18" />
    </>,
    frame: <>
        <line x1="22" x2="2" y1="6" y2="6" />
        <line x1="22" x2="2" y1="18" y2="18" />
        <line x1="6" x2="6" y1="2" y2="22" />
        <line x1="18" x2="18" y1="2" y2="22" />
    </>,
    'figure:rectangle': <rect width="18" height="18" x="3" y="3" rx="2" />,
    'figure:ellipse': <ellipse cx="12" cy="12" rx="10" ry="6" />,
    'figure:triangle': <path d="M13.73 4a2 2 0 0 0-3.46 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z" />,
    'figure:diamond': <path d="M12 3 21 12 12 21 3 12Z" />,
    'figure:hexagon': <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z" />,
    'figure:oval': <rect x="2" y="7" width="20" height="10" rx="5" />,
    'figure:rhombus': <path d="M7 5h14l-4 14H3z" />,
    'figure:star': <path d="M11.525 2.295a.53.53 0 0 1 .95 0l2.31 4.679a2.123 2.123 0 0 0 1.595 1.16l5.166.756a.53.53 0 0 1 .294.904l-3.736 3.638a2.123 2.123 0 0 0-.611 1.878l.882 5.14a.53.53 0 0 1-.771.56l-4.618-2.428a2.122 2.122 0 0 0-1.973 0L6.396 21.01a.53.53 0 0 1-.77-.56l.881-5.139a2.122 2.122 0 0 0-.611-1.879L2.16 9.795a.53.53 0 0 1 .294-.906l5.165-.755a2.122 2.122 0 0 0 1.597-1.16z" />,
    'figure:cloud': <path d="M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9Z" />,
    'figure:heart': <path d="M2 9.5a5.5 5.5 0 0 1 9.591-3.676.56.56 0 0 0 .818 0A5.49 5.49 0 0 1 22 9.5c0 2.29-1.5 4-3 5.5l-5.492 5.313a2 2 0 0 1-3 .019L5 15c-1.5-1.5-3-3.2-3-5.5" />,
    'figure:x-box': <>
        <rect width="18" height="18" x="3" y="3" rx="2" />
        <path d="m15 9-6 6" />
        <path d="m9 9 6 6" />
    </>,
    'figure:check-box': <>
        <rect width="18" height="18" x="3" y="3" rx="2" />
        <path d="m16 9-5.5 5.5L8 12" />
    </>,
    'figure:arrow-left': <>
        <path d="m12 19-7-7 7-7" />
        <path d="M19 12H5" />
    </>,
    'figure:arrow-up': <>
        <path d="m5 12 7-7 7 7" />
        <path d="M12 19V5" />
    </>,
    'figure:arrow-down': <>
        <path d="M12 5v14" />
        <path d="m19 12-7 7-7-7" />
    </>,
    'figure:arrow-right': <>
        <path d="M5 12h14" />
        <path d="m12 5 7 7-7 7" />
    </>,
    more: <path d="m18 15-6-6-6 6" />,
};

/** The glyph key for a tool: the figure's own key for `figure` choices, the id otherwise. */
function toolGlyphKey(id: string, figure?: string): string {
    return id === 'figure' ? `figure:${figure ?? 'rectangle'}` : id;
}

/** A tool's icon at the bar's size: 20px, a 1.5 stroke, in `currentColor`. */
export function ToolIcon({ id, figure }: { readonly id: string; readonly figure?: string }) {
    return <svg width={20} height={20} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5}
        strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
        {GLYPHS[toolGlyphKey(id, figure)]}
    </svg>;
}

/** The chevron that opens the rest of the tools. */
export function MoreToolIcon() {
    return <svg width={20} height={20} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5}
        strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
        {GLYPHS.more}
    </svg>;
}
