// Every glyph the agent panel draws, from one place. The app's shared icons
// (components/icons.tsx) are re-exported; the ones only the panel needs are
// defined HERE, not there, because icons.tsx is in the MAIN bundle — rollup
// places a module whole, so an icon added to it for the panel would ship to
// every reader whether they open the panel or not.
//
// Lucide's paths (lucide-static 1.43.0, ISC), inlined in icons.tsx's style:
// 24-unit viewBox, currentColor stroke 2, `size` setting both dimensions (the
// panel's CSS usually sizes the <svg> itself, which wins over the attribute).

import type { SVGProps } from 'react';

export {
    Check, ChevronDown, ChevronLeft, ChevronRight, FileText, GraduationCap, MoreHorizontal, Pencil,
    Plus, RotateCcw, Search, Sparkles, SquarePen, SquareTerminal, Trash2, X,
} from '../../icons';

interface IconProps extends SVGProps<SVGSVGElement> {
    size?: number;
}

function Glyph({ size = 16, children, ...props }: IconProps) {
    return (
        <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...props}>
            {children}
        </svg>
    );
}

/** Recent chats (the header's history button). */
export function History(props: IconProps) {
    return (
        <Glyph {...props}>
            <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
            <path d="M3 3v5h5" />
            <path d="M12 7v5l4 2" />
        </Glyph>
    );
}

export function Copy(props: IconProps) {
    return (
        <Glyph {...props}>
            <rect width="14" height="14" x="8" y="8" rx="2" ry="2" />
            <path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" />
        </Glyph>
    );
}

/** Starred chats; pass fill="currentColor" for a starred one. */
export function Star(props: IconProps) {
    return (
        <Glyph {...props}>
            <path d="M11.525 2.295a.53.53 0 0 1 .95 0l2.31 4.679a2.123 2.123 0 0 0 1.595 1.16l5.166.756a.53.53 0 0 1 .294.904l-3.736 3.638a2.123 2.123 0 0 0-.611 1.878l.882 5.14a.53.53 0 0 1-.771.56l-4.618-2.428a2.122 2.122 0 0 0-1.973 0L6.396 21.01a.53.53 0 0 1-.77-.56l.881-5.139a2.122 2.122 0 0 0-.611-1.879L2.16 9.795a.53.53 0 0 1 .294-.906l5.165-.755a2.122 2.122 0 0 0 1.597-1.16z" />
        </Glyph>
    );
}

/** The composer's sliders button (learning mode, effort). */
export function SlidersHorizontal(props: IconProps) {
    // A two-slider glyph, not lucide's
    // three: at 16px in a 32px circle lucide's three rows read as a hamburger.
    return (
        <Glyph strokeWidth="1.8" {...props}>
            <path d="M4 7h10M18 7h2M4 17h4M12 17h8" />
            <circle cx="15" cy="7" r="2" />
            <circle cx="9" cy="17" r="2" />
        </Glyph>
    );
}

/** Attach images. Not `Image`: that name would shadow the DOM's Image
 *  constructor in any file that imports it (imagePrep decodes with one). */
export function ImageIcon(props: IconProps) {
    return (
        <Glyph {...props}>
            <rect width="18" height="18" x="3" y="3" rx="2" ry="2" />
            <circle cx="9" cy="9" r="2" />
            <path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21" />
        </Glyph>
    );
}

export function Camera(props: IconProps) {
    return (
        <Glyph {...props}>
            <path d="M13.997 4a2 2 0 0 1 1.76 1.05l.486.9A2 2 0 0 0 18.003 7H20a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V9a2 2 0 0 1 2-2h1.997a2 2 0 0 0 1.759-1.048l.489-.904A2 2 0 0 1 10.004 4z" />
            <circle cx="12" cy="13" r="3" />
        </Glyph>
    );
}

/** "Jump to latest". */
export function ArrowDown(props: IconProps) {
    return (
        <Glyph {...props}>
            <path d="M12 5v14" />
            <path d="m19 12-7 7-7-7" />
        </Glyph>
    );
}

/** Send. */
export function ArrowUp(props: IconProps) {
    return (
        <Glyph {...props}>
            <path d="m5 12 7-7 7 7" />
            <path d="M12 19V5" />
        </Glyph>
    );
}

/** A web fetch or search step. */
export function Globe(props: IconProps) {
    return (
        <Glyph {...props}>
            <circle cx="12" cy="12" r="10" />
            <path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20" />
            <path d="M2 12h20" />
        </Glyph>
    );
}

/** A sub-agent step. */
export function Bot(props: IconProps) {
    return (
        <Glyph {...props}>
            <path d="M12 8V4H8" />
            <rect width="16" height="12" x="4" y="8" rx="2" />
            <path d="M2 14h2" />
            <path d="M20 14h2" />
            <path d="M15 13v2" />
            <path d="M9 13v2" />
        </Glyph>
    );
}

export function Users(props: IconProps) {
    return (
        <Glyph {...props}>
            <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
            <path d="M16 3.128a4 4 0 0 1 0 7.744" />
            <path d="M22 21v-2a4 4 0 0 0-3-3.87" />
            <circle cx="9" cy="7" r="4" />
        </Glyph>
    );
}

/** Stop: a solid rounded square. */
export function Square({ fill = 'currentColor', ...props }: IconProps) {
    return (
        <Glyph fill={fill} {...props}>
            <rect width="14" height="14" x="5" y="5" rx="2" />
        </Glyph>
    );
}

/** A step that read or wrote a file, and the change card's icon box. Plain
 *  (no text lines): at 14px FileText's rules read as noise. */
export function File(props: IconProps) {
    return (
        <Glyph {...props}>
            <path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z" />
            <path d="M14 2v4a2 2 0 0 0 2 2h4" />
        </Glyph>
    );
}

/** A step that made, moved or trashed a folder. */
export function Folder(props: IconProps) {
    return (
        <Glyph {...props}>
            <path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z" />
        </Glyph>
    );
}

/** The panel's mark: a four-pointed spark, filled — the greeting's
 *  and the setup screen's, in the accent. */
export function Spark({ size = 16, ...props }: IconProps) {
    return (
        <svg width={size} height={size} viewBox="0 0 24 24" {...props}>
            <path fill="currentColor" d="M12 2.5c.4 4.3 2.3 7.4 6.6 9.5-4.3 2.1-6.2 5.2-6.6 9.5-.4-4.3-2.3-7.4-6.6-9.5 4.3-2.1 6.2-5.2 6.6-9.5Z" />
        </svg>
    );
}

/** A prompt (">_"): a step that ran a shell
 *  command (and any tool with no better kind), and the CLIs in the ⋯ menu's
 *  agent list. */
export function Terminal(props: IconProps) {
    return (
        <Glyph {...props}>
            <path d="m5 7 5 5-5 5" />
            <path d="M12 17h7" />
        </Glyph>
    );
}
