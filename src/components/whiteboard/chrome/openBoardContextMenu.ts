import { openContextMenu } from '../../../utils/contextMenu';
import { contextEntries, type BoardContextMenuSource } from './boardCommands';

export function openBoardContextMenu(
    source: BoardContextMenuSource,
    label: string,
    point: { readonly x: number; readonly y: number },
    opener: HTMLElement,
): void {
    openContextMenu({ ...point, label, opener, entries: contextEntries(source) });
}

export function handleBoardContextMenu(
    event: Pick<MouseEvent, 'clientX' | 'clientY' | 'preventDefault'>,
    source: BoardContextMenuSource,
    label: string,
    opener: HTMLElement,
): void {
    event.preventDefault();
    openBoardContextMenu(source, label, { x: event.clientX, y: event.clientY }, opener);
}
