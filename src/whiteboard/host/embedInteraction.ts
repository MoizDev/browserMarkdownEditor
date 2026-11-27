import type { EmbedHostingLease } from '../../platform/render/embedPresentation.types';
import { dismissOnEscape } from '../../utils/escapeDismiss';

export function attachEmbedInteraction(hosting: EmbedHostingLease, close: () => void): () => void {
    const viewport = hosting.chrome.parentElement;
    if (!viewport) throw new Error('The embed interaction viewport is unavailable');
    const header = document.createElement('div'), label = document.createElement('span'), button = document.createElement('button');
    header.className = 'board-embed-interaction-controls'; header.setAttribute('role', 'toolbar');
    header.setAttribute('aria-label', 'Embed interaction controls');
    label.textContent = 'Embed interaction — board poster retained';
    button.type = 'button'; button.textContent = 'Unload'; button.setAttribute('aria-label', 'Unload embed');
    header.append(label, button); hosting.chrome.append(header);
    Object.assign(header.style, { position: 'absolute', display: 'none', height: '32px', boxSizing: 'border-box',
        alignItems: 'center', justifyContent: 'space-between', gap: '12px', padding: '4px 8px',
        color: 'var(--text-normal)', background: 'var(--background-secondary)', border: '1px solid var(--background-modifier-border)',
        pointerEvents: 'auto', fontSize: '12px', overflow: 'hidden' });
    let disposed = false, width = 0, height = 0, key = '', stopEscape: (() => void) | undefined;
    const unload = () => { if (!disposed) close(); };
    button.addEventListener('click', unload);
    const context = (event: MouseEvent) => event.preventDefault();
    header.addEventListener('contextmenu', context);
    const update = () => {
        if (disposed) return;
        const node = hosting.getSnapshot().node;
        const eligible = !!node && !node.laterPaint.some(paint => paint.opacity === 'unknown')
            && node.laterPaint.some(paint => paint.opacity === 'translucent');
        const top = 136, bottom = 80;
        const usable = eligible && width > 32 && height > top + 32 + bottom + 48;
        if (!usable) {
            header.style.display = 'none'; stopEscape?.(); stopEscape = undefined;
            if (key !== '') { key = ''; hosting.setInteractionRect(null); }
            return;
        }
        const aspect = node.rect.width / node.rect.height;
        const panelWidth = Math.min(640, width - 32, (height - top - 32 - bottom) * aspect);
        const panelHeight = panelWidth / aspect;
        const band = height - top - bottom;
        const rect = { x: (width - panelWidth) / 2, y: top + Math.max(32, (band - panelHeight + 32) / 2), width: panelWidth, height: panelHeight };
        header.style.display = 'flex'; header.style.left = `${rect.x}px`; header.style.top = `${rect.y - 32}px`;
        header.style.width = `${rect.width}px`;
        stopEscape ??= dismissOnEscape(unload);
        const next = `${rect.x}:${rect.y}:${rect.width}:${rect.height}`;
        if (key !== next) { key = next; hosting.setInteractionRect(rect); }
    };
    const observer = new ResizeObserver(entries => {
        for (const entry of entries) if (entry.target === viewport) {
            width = entry.contentRect.width; height = entry.contentRect.height;
        }
        update();
    });
    const unsubscribe = hosting.subscribe(update);
    observer.observe(viewport);
    update();
    return () => {
        if (disposed) return;
        disposed = true; observer.disconnect(); unsubscribe(); stopEscape?.();
        button.removeEventListener('click', unload); header.removeEventListener('contextmenu', context);
        header.remove(); hosting.setInteractionRect(null);
    };
}
