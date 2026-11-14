type Listener = (message: string) => void;

const listeners = new Set<Listener>();
const reducedPanes = new Set<string>();

export function subscribeRenderStatus(listener: Listener): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
}

function announce(message: string): void {
    for (const listener of listeners) listener(message);
}

/** The broker already limits this signal to once per document session (contracts C4.4:605–609). */
export function reportRenderPinned(): void {
    announce('Graphics interrupted repeatedly. This pane will use standard rendering for this session.');
}

/** Recovered quality ends the episode, allowing a later reduction to be announced (design §6.4:653). */
export function reportRenderQuality(paneId: string, qualityScale: number): void {
    if (qualityScale >= 1) {
        reducedPanes.delete(paneId);
    } else if (!reducedPanes.has(paneId)) {
        reducedPanes.add(paneId);
        announce('Display quality is reduced to keep this pane responsive.');
    }
}

export function clearRenderQuality(paneId: string): void {
    reducedPanes.delete(paneId);
}
