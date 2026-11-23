import React, { useEffect, useId, useRef, useState } from 'react';
import type { ReactNode } from 'react';

/**
 * The app's own modal question — the one used wherever something is about to be
 * destroyed, in place of `window.confirm`.
 *
 * It exists as a component rather than a call because the app already had one of
 * these (deleting an embedded image) and was about to have a second (moving a
 * file or a folder to the Trash), and two hand-rolled overlays drift. Everything
 * a modal owes the reader is here once: the backdrop, Escape, the click
 * outside, the focus it takes and the focus it gives back.
 *
 * It replaces `confirm()` for a reason beyond looks. A native dialog can say a
 * single line of unformatted text, so the question could only ever be "are you
 * sure?" — while what the reader actually needs to know is what becomes of the
 * thing afterwards, which is a sentence with a file name and a folder name in
 * it. That is what `children` is for.
 */
interface ConfirmDialogProps {
    /**
     * Which question is on screen. The component is never remounted between two
     * of them — `raise` swaps one dialog's props for another's in the same
     * React position — so without an identity the field kept the FIRST
     * question's typing and never re-took the keyboard: ⌘N, type a name, ⌘N
     * again, and the new note came up pre-filled with the abandoned one.
     *
     * Omit it where the dialog is MOUNTED per question — EditorPane's image
     * delete is rendered by the request itself, so React's own identity already
     * says what this says.
     */
    questionId?: number;
    title: string;
    /**
     * What going ahead will do. Rich rather than a string: these name files and
     * folders, and a name wants <strong> while a path wants <code>.
     */
    children: ReactNode;
    /** The label on the button that goes ahead. */
    confirmLabel: string;
    /** Whether going ahead destroys something, which colours that button. */
    danger?: boolean;
    /**
     * Turns this into a question with an answer to TYPE — what `prompt()` used
     * to be, and the reason no native dialog is left in the app.
     *
     * Here rather than in a second component for the same reason the third
     * button is: the backdrop, Escape, the click outside and the focus
     * round-trip are owned once, and a hand-rolled overlay beside them drifts.
     */
    input?: {
        label: string;
        initialValue: string;
        placeholder?: string;
        /**
         * Why this value cannot be accepted, or null. Runs on every keystroke:
         * the confirm button is disabled while it returns a reason and the
         * reason is shown under the field — a `prompt()` could only fail
         * silently, after the fact.
         */
        validate?: (value: string) => string | null;
    };
    /** The typed answer, for a dialog with an `input`; ignored by the rest, so
     *  the existing `() => void` call sites still type-check (a function of
     *  fewer parameters is assignable). */
    onConfirm: (value: string) => void;
    /**
     * Back out. ABSENT for a dialog that only REPORTS something — the confirm
     * button is then the only one drawn, and Escape and a click outside do the
     * same thing it does, because there is nothing else they could mean.
     */
    onCancel?: () => void;
    /**
     * A SECOND way of going ahead, drawn between Cancel and the confirm button,
     * and only when `onAlt` comes with it.
     *
     * It exists because one question in the app genuinely has three answers: a
     * put-back from the Trash whose name is already taken can replace what is
     * there or keep both, and cancelling is neither. Folding that into a second
     * hand-rolled overlay is exactly what the doc comment above says this
     * component exists to prevent.
     */
    altLabel?: string;
    /** What the third button does. Never a dismissal — Escape and the click
     *  outside still mean `onCancel`, because backing out is what those mean
     *  everywhere else in the app. */
    onAlt?: () => void;
}

export default function ConfirmDialog({ questionId = 0, title, children, confirmLabel, danger, input, onConfirm, onCancel, altLabel, onAlt }: ConfirmDialogProps) {
    const titleId = useId();
    const inputId = useId();
    const confirmRef = useRef<HTMLButtonElement | null>(null);
    const inputRef = useRef<HTMLInputElement | null>(null);

    // Initialised from the spec of the dialog that is on screen, and RESET when
    // a different question takes the slot (`questionId`) — `raise` replaces the
    // props without remounting, so nothing else would clear the field. Adjusted
    // during render, React's pattern for state that follows a prop.
    const [typed, setTyped] = useState({ id: questionId, value: input?.initialValue ?? '' });
    if (typed.id !== questionId) setTyped({ id: questionId, value: input?.initialValue ?? '' });
    const value = typed.id === questionId ? typed.value : input?.initialValue ?? '';
    const setValue = (next: string) => setTyped({ id: questionId, value: next });
    const reason = input?.validate ? input.validate(value) : null;
    const blocked = !!input && reason !== null;

    // Whatever raised this — a tree row's trash button, usually. Read during the
    // first render, which is BEFORE the commit that moves focus into the dialog,
    // so it is the opener and not our own button.
    const [opener] = useState<HTMLElement | null>(() => document.activeElement as HTMLElement | null);

    // Dismissing is cancelling, or — for a one-button notice — acknowledging.
    // Read through a ref so the listener below is registered exactly once.
    // A one-button notice acknowledges with whatever is in the field, which is
    // nothing — such a dialog has no field. Wrapped rather than passed straight
    // through because `onConfirm` now takes the typed answer.
    const dismiss = onCancel ?? (() => onConfirm(value));
    const dismissRef = useRef(dismiss);
    useEffect(() => { dismissRef.current = dismiss; });

    // Capture phase, and stopped: CodeMirror binds Escape too, and focus may
    // still be sitting in a pane behind this. Same treatment as EditorPane's
    // divider drag, for the same reason.
    useEffect(() => {
        const onKeyDown = (e: KeyboardEvent) => {
            if (e.key !== 'Escape') return;
            e.preventDefault();
            e.stopPropagation();
            dismissRef.current();
        };
        window.addEventListener('keydown', onKeyDown, true);
        return () => window.removeEventListener('keydown', onKeyDown, true);
    }, []);

    // Take the keyboard, and hand it back on the way out — `confirm()` did both,
    // and without them a keyboard user is dropped at the top of the document.
    // Done here rather than with `autoFocus` so that StrictMode's simulated
    // remount (setup → cleanup → setup) still ends with the button focused
    // instead of with the cleanup's restore having the last word.
    //
    // The opener is often GONE by then — it was the trash button of a row the
    // deletion removed — so this only reaches for it while it is still attached.
    //
    // With a field, the FIELD takes it instead and its text is selected — the
    // answer is usually a replacement, not an edit, which is what `prompt()`
    // did too.
    //
    // Taking it is per QUESTION (a second one raised over the first must not be
    // left with the keyboard in a field it no longer owns); handing it back is
    // per MOUNT, and stays in an effect of its own so that a swap does not
    // bounce the focus out to the opener and back.
    useEffect(() => {
        if (inputRef.current) inputRef.current.select();
        else confirmRef.current?.focus();
    }, [questionId]);
    useEffect(() => () => { if (opener?.isConnected) opener.focus(); }, [opener]);

    return (
        <div className="confirm-overlay" onMouseDown={() => dismissRef.current()}>
            <div
                className="confirm-dialog"
                role="dialog"
                aria-modal="true"
                aria-labelledby={titleId}
                onMouseDown={(e) => e.stopPropagation()}
            >
                <h3 className="confirm-title" id={titleId}>{title}</h3>
                <p className="confirm-body">{children}</p>
                {input && (
                    <div className="confirm-input-row">
                        <label className="confirm-input-label" htmlFor={inputId}>{input.label}</label>
                        <input
                            ref={inputRef}
                            id={inputId}
                            className="confirm-input"
                            type="text"
                            value={value}
                            placeholder={input.placeholder}
                            autoComplete="off"
                            spellCheck={false}
                            aria-invalid={reason !== null}
                            aria-describedby={reason ? `${inputId}-error` : undefined}
                            onChange={(e) => setValue(e.target.value)}
                            // Enter IS the confirm button: the field is the only
                            // thing focused, so leaving Enter to the form's
                            // default would submit nothing.
                            onKeyDown={(e) => {
                                if (e.key !== 'Enter' || blocked) return;
                                e.preventDefault();
                                onConfirm(value);
                            }}
                        />
                        {reason && (
                            <span className="confirm-input-error" id={`${inputId}-error`}>{reason}</span>
                        )}
                    </div>
                )}
                <div className="confirm-actions">
                    {onCancel && (
                        <button className="confirm-btn" onClick={onCancel}>Cancel</button>
                    )}
                    {altLabel && onAlt && (
                        <button className="confirm-btn" onClick={onAlt}>{altLabel}</button>
                    )}
                    <button
                        ref={confirmRef}
                        className={`confirm-btn${danger ? ' confirm-btn-danger' : ''}`}
                        disabled={blocked}
                        onClick={() => onConfirm(value)}
                    >
                        {confirmLabel}
                    </button>
                </div>
            </div>
        </div>
    );
}
