import type { ReactNode } from 'react';

function Glyph({ children }: { readonly children: ReactNode }) {
    return <svg width={20} height={20} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5}
        strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">{children}</svg>;
}

const FILL_ICONS: Readonly<Record<string, ReactNode>> = {
    none: <Glyph><rect x="4" y="4" width="16" height="16" rx="2.5" /></Glyph>,
    semi: <Glyph><rect x="4" y="4" width="16" height="16" rx="2.5" fill="currentColor" fillOpacity="0.3" /></Glyph>,
    solid: <Glyph><rect x="4" y="4" width="16" height="16" rx="2.5" fill="currentColor" fillOpacity="0.7" /></Glyph>,
    fill: <Glyph><rect x="4" y="4" width="16" height="16" rx="2.5" fill="currentColor" /></Glyph>,
    pattern: <Glyph><rect x="4" y="4" width="16" height="16" rx="2.5" /><path d="M4 12 12 4M4 20 20 4M12 20l8-8" strokeWidth={1.2} /></Glyph>,
    'lined-fill': <Glyph><rect x="4" y="4" width="16" height="16" rx="2.5" /><path d="M7 8.5h10M7 12h10M7 15.5h10" strokeWidth={1.2} /></Glyph>,
};

const DASH_ICONS: Readonly<Record<string, ReactNode>> = {
    draw: <Glyph><path d="M3 12c1.6-2.2 3-2.2 4.5 0s3 2.2 4.5 0 3-2.2 4.5 0 2.6 2 4.5 0" /></Glyph>,
    solid: <Glyph><path d="M3 12h18" /></Glyph>,
    dashed: <Glyph><path d="M3 12h18" strokeDasharray="4 3" /></Glyph>,
    dotted: <Glyph><path d="M3 12h.01M8 12h.01M13 12h.01M18 12h.01M21 12h.01" strokeWidth={2.4} /></Glyph>,
};

const SIZE_ICONS: Readonly<Record<string, ReactNode>> = {
    s: <Glyph><path d="M4 12h16" strokeWidth={1} /></Glyph>,
    m: <Glyph><path d="M4 12h16" strokeWidth={2.2} /></Glyph>,
    l: <Glyph><path d="M4 12h16" strokeWidth={3.6} /></Glyph>,
    xl: <Glyph><path d="M4 12h16" strokeWidth={5.4} /></Glyph>,
};

const TEXT_ALIGN_ICONS: Readonly<Record<string, ReactNode>> = {
    start: <Glyph><path d="M4 7h14M4 12h9M4 17h11" /></Glyph>,
    middle: <Glyph><path d="M5 7h14M7.5 12h9M6.5 17h11" /></Glyph>,
    end: <Glyph><path d="M6 7h14M11 12h9M9 17h11" /></Glyph>,
};

const VERTICAL_ALIGN_ICONS: Readonly<Record<string, ReactNode>> = {
    start: <Glyph><rect x="4" y="4" width="16" height="16" rx="2.5" /><path d="M8 8.5h8" /></Glyph>,
    middle: <Glyph><rect x="4" y="4" width="16" height="16" rx="2.5" /><path d="M8 12h8" /></Glyph>,
    end: <Glyph><rect x="4" y="4" width="16" height="16" rx="2.5" /><path d="M8 15.5h8" /></Glyph>,
};

const ROUTE_ICONS: Readonly<Record<string, ReactNode>> = {
    arc: <Glyph><path d="M4 19c0-8.3 6.7-15 16-15" /><path d="m16.5 3.5 3.5.5-.5 3.5" /></Glyph>,
    elbow: <Glyph><path d="M4 19V7h16" /><path d="m16.5 3.5 3.5 3.5-3.5 3.5" /></Glyph>,
};

const SPLINE_ICONS: Readonly<Record<string, ReactNode>> = {
    line: <Glyph><path d="M4 18 10 9l4 6 6-7" /></Glyph>,
    cubic: <Glyph><path d="M4 18c3-9 6-9 8-3s5 6 8-7" /></Glyph>,
};

const ARROWHEAD_ICONS: Readonly<Record<string, ReactNode>> = {
    none: <Glyph><path d="M4 12h15" /></Glyph>,
    arrow: <Glyph><path d="M4 12h15" /><path d="m15 7 5 5-5 5" /></Glyph>,
    triangle: <Glyph><path d="M4 12h12" /><path d="M15 7.5 20.5 12 15 16.5z" fill="currentColor" /></Glyph>,
    square: <Glyph><path d="M4 12h13" /><rect x="16.5" y="9.5" width="5" height="5" fill="currentColor" /></Glyph>,
    dot: <Glyph><path d="M4 12h13" /><circle cx="18.5" cy="12" r="2.6" fill="currentColor" /></Glyph>,
    pipe: <Glyph><path d="M4 12h14" /><path d="M19.5 7v10" /></Glyph>,
    diamond: <Glyph><path d="M4 12h11" /><path d="M15 7.5 19.5 12 15 16.5 10.5 12z" fill="currentColor" /></Glyph>,
    inverted: <Glyph><path d="M4 12h12" /><path d="M14.5 7h7l-3.5 9z" fill="currentColor" /></Glyph>,
    bar: <Glyph><path d="M4 12h15" /><path d="M19.5 6.5v11" strokeWidth={2.2} /></Glyph>,
};

const PALETTE_ICON: ReactNode = <Glyph>
    <path d="M12 3a9 9 0 1 0 0 18c1.1 0 1.7-.8 1.7-1.8 0-.5-.2-.9-.5-1.2-.3-.3-.5-.7-.5-1.2 0-1 .8-1.8 1.8-1.8H17a4 4 0 0 0 4-4C21 6.2 17 3 12 3Z" />
    <circle cx="7.5" cy="11" r="1" fill="currentColor" /><circle cx="10.5" cy="7.5" r="1" fill="currentColor" />
    <circle cx="15" cy="8" r="1" fill="currentColor" />
</Glyph>;

const MIXED_ICON: ReactNode = <Glyph>
    <circle cx="12" cy="12" r="8.5" strokeDasharray="3 2.5" />
    <path d="M12 3.5v17" strokeWidth={1} />
</Glyph>;

const CARET_ICON: ReactNode = <svg width={12} height={12} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.2}
    strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false"><path d="m6 9 6 6 6-6" /></svg>;

const GLYPHS: Readonly<Record<GlyphKind, Readonly<Record<string, ReactNode>>>> = {
    fill: FILL_ICONS, dash: DASH_ICONS, size: SIZE_ICONS, align: TEXT_ALIGN_ICONS, valign: VERTICAL_ALIGN_ICONS,
    route: ROUTE_ICONS, spline: SPLINE_ICONS, head: ARROWHEAD_ICONS, palette: { '': PALETTE_ICON }, mixed: { '': MIXED_ICON },
    caret: { '': CARET_ICON },
};

export type GlyphKind = 'fill' | 'dash' | 'size' | 'align' | 'valign' | 'route' | 'spline' | 'head' | 'palette' | 'mixed' | 'caret';

export function StyleGlyph({ kind, value = '' }: { readonly kind: GlyphKind; readonly value?: string }) {
    return <>{GLYPHS[kind][value] ?? null}</>;
}
