import { useEffect, useId, useRef } from 'react';
import './chrome.css';

export interface ShortcutGroup {
    readonly id: string;
    readonly label: string;
    readonly bindings: readonly { readonly id: string; readonly label: string; readonly chord: string }[];
}

export interface ShortcutsDialogProps {
    readonly label: string;
    readonly closeLabel: string;
    readonly groups: readonly ShortcutGroup[];
    readonly returnFocus: HTMLElement | null;
    readonly onClose: () => void;
}

/** Groups are derived by the caller from the board's dispatch keymap. */
export function ShortcutsDialog({ label, closeLabel, groups, returnFocus, onClose }: ShortcutsDialogProps) {
    const labelId = useId();
    const closeButton = useRef<HTMLButtonElement>(null);
    const content = useRef<HTMLDivElement>(null);
    const closeRef = useRef(onClose);
    useEffect(() => { closeRef.current = onClose; }, [onClose]);
    useEffect(() => {
        closeButton.current?.focus();
        const onKey = (event: KeyboardEvent) => {
            if (event.key === 'Escape') {
                event.preventDefault();
                event.stopPropagation();
                closeRef.current();
            } else if (event.key === 'Tab') {
                const active = document.activeElement;
                if (event.shiftKey && active === closeButton.current) {
                    event.preventDefault();
                    content.current?.focus();
                } else if (!event.shiftKey && active === content.current) {
                    event.preventDefault();
                    closeButton.current?.focus();
                }
            }
        };
        window.addEventListener('keydown', onKey, true);
        return () => {
            window.removeEventListener('keydown', onKey, true);
            if (returnFocus?.isConnected) returnFocus.focus({ preventScroll: true });
        };
    }, [returnFocus]);

    return <div className="board-shortcuts-backdrop" onMouseDown={event => {
        if (event.target === event.currentTarget) onClose();
    }}>
        <section className="board-shortcuts-dialog" role="dialog" aria-modal="true" aria-labelledby={labelId}>
            <header className="board-shortcuts-header"><h2 id={labelId}>{label}</h2>
                <button type="button" ref={closeButton} className="board-chrome-tool" onClick={onClose}>{closeLabel}</button>
            </header>
            <div ref={content} tabIndex={0} className="board-shortcuts-content">
                {groups.map(group => <section key={group.id}>
                    <h3>{group.label}</h3>
                    <dl>{group.bindings.map(binding => <div key={binding.id} className="board-shortcut-row">
                        <dt>{binding.label}</dt><dd><kbd>{binding.chord}</kbd></dd>
                    </div>)}</dl>
                </section>)}
            </div>
        </section>
    </div>;
}
