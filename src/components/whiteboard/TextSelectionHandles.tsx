interface HandlePoint { readonly x: number; readonly y: number }
interface TextSelectionHandlesProps {
    readonly anchor: HandlePoint;
    readonly focus: HandlePoint;
    readonly down: (which: 'anchor' | 'focus', event: React.PointerEvent<HTMLButtonElement>) => void;
    readonly move: (event: React.PointerEvent<HTMLButtonElement>) => void;
    readonly up: (event: React.PointerEvent<HTMLButtonElement>) => void;
}

export function TextSelectionHandles({ anchor, focus, down, move, up }: TextSelectionHandlesProps) {
    return <>
        {(['anchor', 'focus'] as const).map(which => {
            const p = which === 'anchor' ? anchor : focus;
            return <button key={which} type="button" tabIndex={-1} aria-label={which === 'anchor' ? 'Start of text selection' : 'End of text selection'}
                style={{ position: 'fixed', left: p.x - 22, top: p.y - 8, width: 44, height: 44, zIndex: 1000, padding: 0, border: 0, background: 'transparent', touchAction: 'none' }}
                onContextMenu={event => event.preventDefault()}
                onPointerDown={event => { event.currentTarget.setPointerCapture(event.pointerId); down(which, event); }}
                onPointerMove={move} onPointerUp={up} onPointerCancel={up}>
                <span aria-hidden="true" style={{ display: 'block', width: 12, height: 12, margin: '0 auto', borderRadius: '50%', background: 'var(--interactive-accent)' }} />
            </button>;
        })}
    </>;
}
