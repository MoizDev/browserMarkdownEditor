import { useSyncExternalStore } from 'react';
import { BoardChrome, type BoardChromeProps } from './BoardChrome';

export interface ToolStateView {
    getSnapshot(): { readonly active: { readonly id: string; readonly variant?: string }; readonly lastFigure?: string; readonly locked: boolean };
    subscribe(listener: () => void): () => void;
    setTool(id: string, variant?: string): void;
    toggleLocked(): void;
    /** Only single-use tools can be locked: the tool lock keeps them chosen after each use. */
    lockable(id: string): boolean;
    /** The tools the bar shows now, in order; the number keys press them. */
    setBarTools(choices: readonly { readonly id: string; readonly variant?: string }[]): void;
    /** A press on a bar tool that is dragged onto the board; the board takes it or not. */
    beginDrag?(choice: { readonly id: string; readonly variant?: string; readonly label?: string }, event: PointerEvent, bar: Element): boolean;
}

export interface ConnectedBoardChromeProps extends Omit<BoardChromeProps, 'selectedTool' | 'selectTool' | 'dragTool' | 'lastFigure' | 'toolLock' | 'onBarTools'> {
    readonly toolState: ToolStateView;
    readonly openMedia: () => void;
}

export function ConnectedBoardChrome({ toolState, openMedia, ...props }: ConnectedBoardChromeProps) {
    const snapshot = useSyncExternalStore(toolState.subscribe, toolState.getSnapshot, toolState.getSnapshot);
    return <BoardChrome {...props}
        selectedTool={{ id: snapshot.active.id, figure: snapshot.active.variant, label: '' }}
        lastFigure={snapshot.lastFigure}
        toolLock={toolState.lockable(snapshot.active.id) ? { locked: snapshot.locked, toggle: toolState.toggleLocked } : undefined}
        onBarTools={shown => toolState.setBarTools(shown.map(choice => ({ id: choice.id, variant: choice.figure })))}
        dragTool={toolState.beginDrag && ((choice, event, bar) => toolState.beginDrag!({ id: choice.id, variant: choice.figure, label: choice.label }, event, bar))}
        selectTool={choice => {
            if (choice.id === 'media') openMedia();
            else toolState.setTool(choice.id, choice.figure);
        }} />;
}
