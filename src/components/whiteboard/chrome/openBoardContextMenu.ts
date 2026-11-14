import { openContextMenu } from '../../../utils/contextMenu';
import { contextEntries, type BoardContextMenuSource } from './boardCommands';

export function openBoardContextMenu(
    source: BoardContextMenuSource,
    label: string,
    point: { readonly x: number; readonly y: number },
    opener: HTMLElement,
    language?: { readonly locale: string; readonly direction: 'ltr' | 'rtl' },
): void {
    openContextMenu({ ...point, label, opener, lang: language?.locale, dir: language?.direction, entries: contextEntries(source) });
}

export function handleBoardContextMenu(
    event: Pick<MouseEvent, 'clientX' | 'clientY' | 'preventDefault'>,
    source: BoardContextMenuSource,
    label: string,
    opener: HTMLElement,
    language?: { readonly locale: string; readonly direction: 'ltr' | 'rtl' },
): void {
    event.preventDefault();
    openBoardContextMenu(source, label, { x: event.clientX, y: event.clientY }, opener, language);
}
