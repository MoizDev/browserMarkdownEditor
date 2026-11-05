// A live label's brightness sweep — "Thinking…", "Reading your view…",
// "Stopping…", "Connecting to VaultAgent…". Only the look: the caller decides
// what the text says and whether it is announced (a role="status" around it).
// Styled in styles/frame.css (.va-shimmer); static tertiary text under
// prefers-reduced-motion.

import type { HTMLAttributes, ReactNode } from 'react';

export interface ShimmerProps extends HTMLAttributes<HTMLSpanElement> {
    children: ReactNode;
}

export function Shimmer({ children, className, ...rest }: ShimmerProps) {
    return (
        <span {...rest} className={'va-shimmer' + (className ? ' ' + className : '')}>
            {children}
        </span>
    );
}
