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
