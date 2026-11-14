import type { BoardAccessibilitySource } from './BoardAccessibility';
import type { BoardSessionPort } from './boardSessionAdapter';
import type { AttachBoardView, BoardViewLease, BoardViewParameters, BoardViewSnapshot } from './boardHostRuntime';
import type { ViewerHostProps, ViewerViewHandle } from './ViewerHost';

/** The renderer and input adapter are injected by the lazy engine entry. */
export interface BoardViewEngine<T extends object> {
    readonly accessibility: BoardAccessibilitySource;
    getSnapshot(): { readonly layers: ViewerHostProps<T>['layers']; readonly readOnlyReason: string | null };
    subscribe(listener: () => void): () => void;
    setView(view: { visible: boolean; focused: boolean; theme: 'light' | 'dark'; inverted: boolean }): void;
    dispose(): void;
}
export type AttachBoardInput<S extends BoardSessionPort, T extends object> = (
    board: S, engine: BoardViewEngine<T>, mode: BoardViewParameters['mode'], interaction: HTMLElement, overlay: HTMLElement,
) => () => void;

/** Adapt one engine view to the common shell without creating or owning a second session. */
export function createBoardViewLease<S extends BoardSessionPort, T extends object>(
    board: S, engine: BoardViewEngine<T>, platform: ViewerHostProps<T>['platform'],
    mode: BoardViewParameters['mode'], input: AttachBoardInput<S, T>,
    viewExtras: Readonly<Record<string, unknown>> = {},
): BoardViewLease<T> {
    let prior: ReturnType<BoardViewEngine<T>['getSnapshot']> | undefined;
    let snapshot: BoardViewSnapshot<T> | undefined;
    const view: ViewerViewHandle = {
        accessibility: engine.accessibility,
        subscribe: listener => engine.subscribe(listener),
        setView: parameters => engine.setView({ ...viewExtras, ...parameters }),
        attachInput: (interaction, overlay) => input(board, engine, mode, interaction, overlay),
    };
    return {
        view,
        getSnapshot() {
            const next = engine.getSnapshot();
            if (!snapshot || next.layers !== prior?.layers || next.readOnlyReason !== prior?.readOnlyReason) {
                prior = next;
                snapshot = { layers: next.layers, platform, reason: next.readOnlyReason };
            }
            return snapshot!;
        },
        subscribe: listener => engine.subscribe(listener),
        dispose: () => engine.dispose(),
    };
}

/** Engine construction is per view, but the App-owned board identity is mandatory. */
export function createBoardViewAttacher<S extends BoardSessionPort, T extends object>(options: {
    attachEngine(board: S, parameters: BoardViewParameters): BoardViewEngine<T> & { readonly session: S };
    readonly platform: ViewerHostProps<T>['platform'];
    readonly input: AttachBoardInput<S, T>;
    readonly viewExtras?: Readonly<Record<string, unknown>>;
}): AttachBoardView<S, T> {
    return (board, parameters) => {
        const engine = options.attachEngine(board, parameters);
        if (engine.session !== board) { engine.dispose(); throw new Error('Board view attached the wrong session'); }
        return createBoardViewLease(board, engine, options.platform, parameters.mode, options.input, options.viewExtras);
    };
}
