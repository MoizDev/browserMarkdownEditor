import React, { useEffect, useId, useRef, useState } from 'react';
import type { ReactNode } from 'react';

interface ConfirmDialogProps {
    questionId?: number;
    title: string;
    children: ReactNode;
    confirmLabel: string;
    cancelLabel?: string;
    danger?: boolean;
    input?: {
        label: string;
        initialValue: string;
        type?: 'text' | 'password';
        placeholder?: string;
        validate?: (value: string) => string | null;
    };
    onConfirm: (value: string) => void;
    onCancel?: () => void;
    altLabel?: string;
    onAlt?: () => void;
}

const openDialogs: object[] = [];

export default function ConfirmDialog({ questionId = 0, title, children, confirmLabel, cancelLabel, danger, input, onConfirm, onCancel, altLabel, onAlt }: ConfirmDialogProps) {
    const titleId = useId();
    const inputId = useId();
    const confirmRef = useRef<HTMLButtonElement | null>(null);
    const dialogRef = useRef<HTMLDivElement | null>(null);
    const inputRef = useRef<HTMLInputElement | null>(null);

    const [typed, setTyped] = useState({ id: questionId, value: input?.initialValue ?? '' });
    if (typed.id !== questionId) setTyped({ id: questionId, value: input?.initialValue ?? '' });
    const value = typed.id === questionId ? typed.value : input?.initialValue ?? '';
    const setValue = (next: string) => setTyped({ id: questionId, value: next });
    const invalid = input?.validate ? input.validate(value) : null;
    const reason = value === (input?.initialValue ?? '') ? null : invalid;
    const blocked = !!input && invalid !== null;

    // Whatever raised this — a tree row's trash button, usually. Read during the
    // first render, which is BEFORE the commit that moves focus into the dialog,
    // so it is the opener and not our own button.
    const [opener] = useState<HTMLElement | null>(() => document.activeElement as HTMLElement | null);

    const dismiss = onCancel ?? (() => onConfirm(value));
    const dismissRef = useRef(dismiss);
    useEffect(() => { dismissRef.current = dismiss; });

    useEffect(() => {
        const token = {};
        openDialogs.push(token);
        const onKeyDown = (e: KeyboardEvent) => {
            if (openDialogs[openDialogs.length - 1] !== token) return;
            if (e.key === 'Tab' && !e.altKey && !e.ctrlKey && !e.metaKey) {
                const controls = [...dialogRef.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), a[href], [tabindex]:not([tabindex="-1"])') ?? []];
                if (!controls.length) return;
                const at = controls.indexOf(document.activeElement as HTMLElement);
                const next = at < 0 ? (e.shiftKey ? controls.length - 1 : 0)
                    : e.shiftKey ? (at === 0 ? controls.length - 1 : -1) : (at === controls.length - 1 ? 0 : -1);
                if (next < 0) return;
                e.preventDefault();
                e.stopPropagation();
                controls[next].focus();
                return;
            }
            if (e.key !== 'Escape') return;
            e.preventDefault();
            e.stopPropagation();
            dismissRef.current();
        };
        window.addEventListener('keydown', onKeyDown, true);
        return () => {
            window.removeEventListener('keydown', onKeyDown, true);
            const at = openDialogs.indexOf(token);
            if (at >= 0) openDialogs.splice(at, 1);
        };
    }, []);

    useEffect(() => {
        if (inputRef.current) inputRef.current.select();
        else confirmRef.current?.focus();
    }, [questionId]);
    useEffect(() => () => { if (opener?.isConnected) opener.focus(); }, [opener]);

    return (
        <div className="confirm-overlay" onMouseDown={() => dismissRef.current()}>
            <div
                ref={dialogRef}
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
                            type={input.type ?? 'text'}
                            value={value}
                            placeholder={input.placeholder}
                            autoComplete="off"
                            spellCheck={false}
                            aria-invalid={reason !== null}
                            aria-describedby={reason ? `${inputId}-error` : undefined}
                            onChange={(e) => setValue(e.target.value)}
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
                        <button className="confirm-btn" onClick={onCancel}>{cancelLabel ?? 'Cancel'}</button>
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
