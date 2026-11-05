// The rows of every panel popover (model, chats, title, ⋯, +, sliders, retry),
// one shape for all: an optional icon, the title over an optional
// one-line description, and at the right a ✓ (the chosen row of a pick-one
// list), a meta string ("0.2.4"), or › for a row that opens more.
// Styled in styles/popovers.css (.va-menu-row, .va-menu-section, .va-menu-sep).
//
// A row is a <button>, so Popover's ↑/↓ and its focus-the-chosen-row-on-open
// find it. In a `menu` popover it is a menuitem — menuitemradio when `checked`
// is given at all, so a pick-one list announces its choice; in a `dialog` one
// (ui/popoverRole.ts) a plain button, or a radio when `checked` is given. A
// disabled row stays in the list and says why on hover (`reason` →
// data-tooltip): a dead row that does not explain itself reads as a bug
// (app-context-menu).

import { useContext } from 'react';
import type { ReactNode, Ref } from 'react';
import { Check, ChevronRight } from './icons';
import { PopoverRoleContext } from './popoverRole';

export interface MenuRowProps {
    title: ReactNode;
    /** One quiet line under the title (12px, --va-text-500). */
    description?: ReactNode;
    icon?: ReactNode;
    /** Present = a pick-one row; true draws the ✓. */
    checked?: boolean;
    /** Right-aligned secondary text, e.g. a version. */
    meta?: ReactNode;
    danger?: boolean;
    disabled?: boolean;
    /** Why a disabled row cannot act — its tooltip. */
    reason?: string;
    /** Draws › : the row opens or expands more rows. */
    more?: boolean;
    onSelect: () => void;
    className?: string;
    ref?: Ref<HTMLButtonElement>;
}

export function MenuRow({ title, description, icon, checked, meta, danger, disabled, reason, more, onSelect, className, ref }: MenuRowProps) {
    const inMenu = useContext(PopoverRoleContext) === 'menu';
    const pick = checked !== undefined;
    let role: string | undefined;
    if (inMenu) role = pick ? 'menuitemradio' : 'menuitem';
    else if (pick) role = 'radio';
    let end: ReactNode = null;
    if (checked) end = <span className="va-menu-row-end" aria-hidden="true"><Check /></span>;
    else if (more) end = <span className="va-menu-row-end is-more" aria-hidden="true"><ChevronRight /></span>;
    return (
        <button
            ref={ref}
            type="button"
            role={role}
            aria-checked={pick ? checked : undefined}
            disabled={disabled}
            data-tooltip={disabled ? reason : undefined}
            className={'va-menu-row' + (danger ? ' is-danger' : '') + (className ? ' ' + className : '')}
            onClick={onSelect}
        >
            {icon && <span className="va-menu-row-icon" aria-hidden="true">{icon}</span>}
            <span className="va-menu-row-main">
                <span className="va-menu-row-title">{title}</span>
                {description && <span className="va-menu-row-desc">{description}</span>}
            </span>
            {meta != null && meta !== '' && <span className="va-menu-row-meta">{meta}</span>}
            {end}
        </button>
    );
}

/** An uppercase section label ("MODEL", "AGENT FOR NEW CHATS"). */
export function MenuSection({ label }: { label: string }) {
    return <div className="va-menu-section" role="presentation">{label}</div>;
}

export function MenuSeparator() {
    return <div className="va-menu-sep" role="separator" />;
}
