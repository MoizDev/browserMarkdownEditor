import { useSyncExternalStore } from 'react';
import { BoardChrome, type BoardChromeProps } from './BoardChrome';

export interface ToolStateView {
    getSnapshot(): { readonly active: { readonly id: string; readonly variant?: string }; readonly lastFigure?: string };
    subscribe(listener: () => void): () => void;
    setTool(id: string, variant?: string): void;
}

export interface ConnectedBoardChromeProps extends Omit<BoardChromeProps, 'selectedTool' | 'lastFigure' | 'selectTool'> {
    readonly toolState: ToolStateView;
    readonly openMedia: () => void;
}

export function ConnectedBoardChrome({ toolState, openMedia, ...props }: ConnectedBoardChromeProps) {
    const snapshot = useSyncExternalStore(toolState.subscribe, toolState.getSnapshot, toolState.getSnapshot);
    return <BoardChrome {...props}
        selectedTool={{ id: snapshot.active.id, figure: snapshot.active.variant, label: '' }}
        lastFigure={snapshot.lastFigure ?? 'rectangle'}
        selectTool={choice => {
            if (choice.id === 'media') openMedia();
            else toolState.setTool(choice.id, choice.figure);
        }} />;
}
