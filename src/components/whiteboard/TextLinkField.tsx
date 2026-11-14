import { useEffect, useRef, useState } from 'react';

interface TextLinkFieldProps {
    readonly x: number;
    readonly y: number;
    readonly initial: string;
    readonly normalizeUrl: (value: string) => string | null;
    readonly commit: (url: string) => void;
    readonly cancel: () => void;
    readonly visit: (url: string) => void;
    readonly contextMenu: (event: React.MouseEvent<HTMLInputElement>) => void;
}

// The edit selection lives in the board session, not in this field. Enter and
// Escape stop here so neither can become an edit-host text operation (WB-D26).
export function TextLinkField({ x, y, initial, normalizeUrl, commit, cancel, visit, contextMenu }: TextLinkFieldProps) {
    const [value, setValue] = useState(initial);
    const [invalid, setInvalid] = useState(false);
    const root = useRef<HTMLDivElement>(null);
    const input = useRef<HTMLInputElement>(null);
    useEffect(() => { input.current?.focus(); input.current?.select(); }, []);
    useEffect(() => {
        const outside = (event: PointerEvent) => {
            if (root.current?.contains(event.target as Node)) return;
            const url = normalizeUrl(value);
            if (url) commit(url);
            else setInvalid(true);
        };
        document.addEventListener('pointerdown', outside, true);
        return () => document.removeEventListener('pointerdown', outside, true);
    }, [value, normalizeUrl, commit]);
    const accept = () => {
        const url = normalizeUrl(value);
        if (!url) { setInvalid(true); return; }
        commit(url);
    };
    return <div ref={root} role="dialog" aria-label="Edit text link" style={{ position: 'fixed', left: x, top: y, zIndex: 1000, padding: 8, background: 'var(--bg-primary)', border: '1px solid var(--border-color)', borderRadius: 6 }}
        onContextMenu={event => { if (event.target !== input.current) event.preventDefault(); }}>
        <label>URL <input ref={input} value={value} aria-invalid={invalid} onChange={event => { setValue(event.target.value); setInvalid(false); }}
            onContextMenu={event => { event.preventDefault(); contextMenu(event); }}
            onKeyDown={event => {
                if (event.key !== 'Enter' && event.key !== 'Escape') return;
                event.preventDefault(); event.stopPropagation();
                if (event.key === 'Escape') cancel(); else accept();
            }} /></label>
        <button type="button" onClick={accept}>Apply</button>
        <button type="button" disabled={!normalizeUrl(value)} onClick={() => { const url = normalizeUrl(value); if (url) visit(url); }}>Visit link</button>
        {invalid && <div role="alert">Enter an http, https or mailto URL.</div>}
    </div>;
}
