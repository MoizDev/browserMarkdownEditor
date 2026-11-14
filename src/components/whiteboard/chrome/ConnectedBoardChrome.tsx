import { useSyncExternalStore } from 'react';
import type { ToolState } from '../../../whiteboard/input/gesture';
import { BoardChrome, type BoardChromeProps } from './BoardChrome';

export interface ConnectedBoardChromeProps extends Omit<BoardChromeProps, 'selectedTool' | 'lastFigure' | 'selectTool'> {
    readonly toolState: ToolState;
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
