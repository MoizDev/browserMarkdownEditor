// A segmented control: Learning mode (Auto / Always / Off), Effort (the
// model's levels). A radiogroup, so it is ONE Tab stop: the keyboard lands on
// the chosen segment and ←/→ move the choice along, wrapping, as a native
// radio group does. ↑/↓ are left alone on purpose: inside a Popover they move
// to the control above or below, and Popover's walk visits the chosen segment
// (the group's one Tab stop) like any row. A popover holding one is a
// `dialog`, never a `menu`, which may own only menuitems (ui/popoverRole.ts).
// Styled in styles/popovers.css (.va-segmented).

import { useRef } from 'react';
import type { KeyboardEvent } from 'react';

export interface SegmentedProps {
    options: string[];
    value: string;
    onChange: (value: string) => void;
    /** The group's accessible name ("Effort"). */
    label?: string;
    /** Display text for an option; the option itself otherwise. */
    format?: (value: string) => string;
    /** The option's full name, when `format` shortens it ("Med" → "Medium"):
     *  its accessible name and its tooltip. */
    fullName?: (value: string) => string;
    disabled?: boolean;
    className?: string;
}

export function Segmented({ options, value, onChange, label, format, fullName, disabled, className }: SegmentedProps) {
    const buttons = useRef<(HTMLButtonElement | null)[]>([]);
    // A value that is not an option (a model that lost the level the chat was
    // set to) still leaves the group reachable by Tab.
    const chosen = options.indexOf(value);
    const tabStop = chosen >= 0 ? chosen : 0;

    const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>, at: number) => {
        if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
        e.preventDefault();
        const step = e.key === 'ArrowRight' ? 1 : -1;
        const next = (at + step + options.length) % options.length;
        buttons.current[next]?.focus();
        if (options[next] !== value) onChange(options[next]);
    };

    return (
        <div role="radiogroup" aria-label={label} aria-disabled={disabled || undefined} className={'va-segmented' + (className ? ' ' + className : '')}>
            {options.map((option, i) => {
                const text = format ? format(option) : option;
                const full = fullName?.(option);
                const named = full && full !== text ? full : undefined;
                return (
                    <button
                        key={option}
                        ref={el => { buttons.current[i] = el; }}
                        type="button"
                        role="radio"
                        aria-checked={option === value}
                        tabIndex={i === tabStop ? 0 : -1}
                        disabled={disabled}
                        aria-label={named}
                        data-tooltip={named}
                        data-tooltip-position={named ? 'top' : undefined}
                        className="va-segment"
                        onClick={() => { if (option !== value) onChange(option); }}
                        onKeyDown={e => onKeyDown(e, i)}
                    >
                        {text}
                    </button>
                );
            })}
        </div>
    );
}
