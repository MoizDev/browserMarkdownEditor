export interface BoardViewFlags {
    readonly grid: boolean;
    readonly focusMode: boolean;
    readonly toolLock: boolean;
    readonly transparent: boolean;
    readonly debugMode: boolean;
}

export interface BoardSessionPreferences {
    readonly edgeScrolling: boolean;
    readonly pasteAtCursor: boolean;
}

export interface BoardLocalPreferences {
    readonly view: BoardViewFlags;
    readonly session: BoardSessionPreferences;
}

export const DEFAULT_BOARD_VIEW_FLAGS: BoardViewFlags = Object.freeze({
    grid: false, focusMode: false, toolLock: false, transparent: false, debugMode: false,
});

export function readBoardViewFlags(value: unknown): BoardViewFlags {
    const source = value && typeof value === 'object' ? value as Partial<Record<keyof BoardViewFlags, unknown>> : {};
    return {
        grid: source.grid === true, focusMode: source.focusMode === true, toolLock: source.toolLock === true,
        transparent: source.transparent === true, debugMode: source.debugMode === true,
    };
}

export interface BoardPreferenceState {
    reconcileView(view: BoardViewFlags): void;
}

// The host persists view flags through the file save funnel, or the PDF view record for PDF ink.
export class BoardPreferenceState {
    private snapshot: BoardLocalPreferences;
    private readonly listeners = new Set<() => void>();

    constructor(view: BoardViewFlags, private readonly persistView: (flags: BoardViewFlags) => void) {
        this.snapshot = { view: { ...view }, session: { edgeScrolling: true, pasteAtCursor: false } };
    }

    getSnapshot = (): BoardLocalPreferences => this.snapshot;
    subscribe = (listener: () => void): (() => void) => {
        this.listeners.add(listener);
        return () => { this.listeners.delete(listener); };
    };

    setView<K extends keyof BoardViewFlags>(key: K, value: BoardViewFlags[K]): void {
        if (this.snapshot.view[key] === value) return;
        const view = { ...this.snapshot.view, [key]: value };
        this.snapshot = { ...this.snapshot, view };
        this.persistView(view);
        this.notify();
    }

    setSession<K extends keyof BoardSessionPreferences>(key: K, value: BoardSessionPreferences[K]): void {
        if (this.snapshot.session[key] === value) return;
        this.snapshot = { ...this.snapshot, session: { ...this.snapshot.session, [key]: value } };
        this.notify();
    }

    private notify(): void { for (const listener of this.listeners) listener(); }
}
