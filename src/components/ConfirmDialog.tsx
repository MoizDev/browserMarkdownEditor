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
    onConfirm: () => void;
    /**
     * Back out. ABSENT for a dialog that only REPORTS something — the confirm
     * button is then the only one drawn, and Escape and a click outside do the
     * same thing it does, because there is nothing else they could mean.
     */
    onCancel?: () => void;
}

export default function ConfirmDialog({ title, children, confirmLabel, danger, onConfirm, onCancel }: ConfirmDialogProps) {
    const titleId = useId();
    const confirmRef = useRef<HTMLButtonElement | null>(null);

    // Whatever raised this — a tree row's trash button, usually. Read during the
    // first render, which is BEFORE the commit that moves focus into the dialog,
    // so it is the opener and not our own button.
    const [opener] = useState<HTMLElement | null>(() => document.activeElement as HTMLElement | null);

    // Dismissing is cancelling, or — for a one-button notice — acknowledging.
    // Read through a ref so the listener below is registered exactly once.
    const dismiss = onCancel ?? onConfirm;
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
    useEffect(() => {
        confirmRef.current?.focus();
        return () => { if (opener?.isConnected) opener.focus(); };
    }, [opener]);

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
                <div className="confirm-actions">
                    {onCancel && (
                        <button className="confirm-btn" onClick={onCancel}>Cancel</button>
                    )}
                    <button
                        ref={confirmRef}
                        className={`confirm-btn${danger ? ' confirm-btn-danger' : ''}`}
                        onClick={onConfirm}
                    >
                        {confirmLabel}
                    </button>
                </div>
            </div>
        </div>
    );
}
