/** Why a pane runs on canvas2d for good, as the person is told: no WebGL2 at all, a software WebGL2 (SwiftShader, llvmpipe, WARP:
 * the CPU drawing through WebGL), a graphics card that fails qualification, or repeated GPU errors on this document. Defined here,
 * not with the broker, so the App's status module names it without importing the renderer. */
export type GpuUnavailableCause = 'no-webgl2' | 'software' | 'unsupported' | 'gpu-error' | 'too-many-panes';

type Listener = (message: string) => void;

const listeners = new Set<Listener>();

export function subscribeRenderStatus(listener: Listener): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
}

function announce(message: string): void {
    for (const listener of listeners) listener(message);
}

export function reportRenderPinned(): void {
    announce('Graphics interrupted repeatedly. This pane will use standard rendering for this session.');
}

// Reduced quality is not announced here: the pane says so itself ('memory-pressure', once its own grant has kept it below full quality
// for a second, withdrawn when it returns). Announced here too, at the first soft present, the status line repeated it at once and
// covered the board's own notice and its Dismiss button (seen with a forced degrade, two PDFs and a board side by side).

/** What the person reads when a pane draws in a compatible mode (canvas2d) for good, by why. The browser setting is named because it is
 * the one thing the person can change: Chrome's "Use graphics acceleration when available" turns software rendering back into the GPU. */
export function gpuUnavailableText(cause: GpuUnavailableCause | undefined): string {
    switch (cause) {
        case 'no-webgl2': return 'GPU rendering is unavailable in this browser, so a compatible mode is in use. Turning on graphics acceleration in the browser settings may help.';
        case 'software': return 'This browser draws graphics in software, not on the graphics card, so a compatible mode is in use. Turning on graphics acceleration in the browser settings may help.';
        case 'unsupported': return 'This graphics card lacks a feature GPU rendering needs, so a compatible mode is in use.';
        case 'too-many-panes': return 'Five documents are already drawing on the graphics card, so this one uses a compatible mode until one of them is closed or hidden.';
        case 'gpu-error': return 'GPU rendering failed repeatedly on this document, so a compatible mode is in use for this document.';
        default: return 'GPU rendering is unavailable; a compatible mode is in use.';
    }
}
