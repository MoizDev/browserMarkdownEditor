// The panel's square icon button: 30px with a 17px glyph in the header, 26px
// under a reply, 24px under a user message (styles/frame.css, .va-icon-btn).
// The glyph's size comes from the CSS, so any icon component works at any of
// the three.
//
// It has no visible text, so `label` is required and becomes BOTH the
// aria-label and, unless told otherwise, the app's own tooltip (`data-tooltip`,
// drawn by utils/tooltip.ts — never a native `title`). `tooltip` differs from
// the label when the bubble should say more ("Close (⌘⇧X)"); `null` draws none.
//
// `ref` is a plain prop (React 19): popovers anchor on this button.

import type { ComponentPropsWithRef, ReactNode } from 'react';

export type IconButtonSize = '30' | '26' | '24';

export interface IconButtonProps extends Omit<ComponentPropsWithRef<'button'>, 'title' | 'children'> {
    /** The accessible name. */
    label: string;
    /** The tooltip, when it should differ from `label`; `null` draws none. */
    tooltip?: string | null;
    tooltipPosition?: 'top' | 'bottom' | 'left' | 'right';
    size?: IconButtonSize;
    children: ReactNode;
}

export function IconButton({ label, tooltip, tooltipPosition, size = '30', className, type = 'button', children, ...rest }: IconButtonProps) {
    const tip = tooltip === undefined ? label : tooltip;
    return (
        <button
            {...rest}
            type={type}
            className={'va-icon-btn' + (className ? ' ' + className : '')}
            data-size={size}
            aria-label={label}
            data-tooltip={tip ?? undefined}
            data-tooltip-position={tip ? tooltipPosition : undefined}
        >
            {children}
        </button>
    );
}
