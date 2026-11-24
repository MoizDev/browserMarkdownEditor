import { useMemo, useState, type ReactNode } from 'react';
import LucideGlyph from '../LucideGlyph';
import { openContextMenu } from '../../utils/contextMenu';
import { ZoomControls } from './chrome/ZoomControls';
import { headerIcons, readOnlyIcons } from './chrome/boardIcons';
import type { MainAction } from './chrome/mainMenu';
import type { CommandState } from './chrome/boardCommands';
import type { createNativeCameraOperations } from './nativeCameraOperations';
import './chrome/chrome.css';
import './readOnlyChrome.css';

/** The zoom panel's rows a view can run; every other action has no place on a board nobody can change. */
const ZOOM_LABELS: Partial<Record<MainAction, string>> = {
    zoomIn: 'Zoom in', zoomOut: 'Zoom out', zoomTo100: 'Zoom to 100%', zoomToFit: 'Zoom to fit',
    zoomToSelection: 'Zoom to selection', toggleMinimap: 'Minimap',
};
const UNAVAILABLE: CommandState = Object.freeze({ enabled: false, reason: 'Not available while viewing' });

export interface ReadOnlyBoardChromeProps {
    readonly camera: ReturnType<typeof createNativeCameraOperations>;
    readonly zoom: number;
    readonly minimapOpen: boolean;
    readonly kind: 'whiteboard' | 'notebook' | 'pdf-ink';
    readonly sheets: readonly { readonly id: string; readonly name: string }[];
    readonly sheet: string;
    readonly setSheet: (id: string) => void;
    readonly inverted: boolean;
    readonly setInverted: (inverted: boolean) => void;
    /** A notebook's page panel, drawn under the strip while open. */
    readonly thumbnails?: (open: boolean, setOpen: (open: boolean) => void) => ReactNode;
    /** The document's print and PDF export (useNativeClipboard.ts), null until its command service is ready. Neither
     *  changes the board: a print or an export reads it. */
    readonly output: { readonly print: () => boolean; readonly exportPdf: () => boolean } | null;
    /** An old-format board: what the strip says about it, and its copy. Absent for any other read-only view. */
    readonly oldBoard?: { readonly kind: 'drawing' | 'notebook'; readonly copying: boolean; readonly onCopy: (trigger: HTMLElement) => void };
}

/**
 * The read-only view's chrome, in the editing chrome's places and look (chrome.css): the strip in the top-left corner,
 * the zoom panel in the bottom-right. Nothing that edits is drawn at all, so nothing on screen silently does nothing; an
 * old-format board's strip says once what it is, and carries the one way on: Make an editable copy.
 */
export function ReadOnlyBoardChrome({ camera, zoom, minimapOpen, kind, sheets, sheet, setSheet, inverted, setInverted, thumbnails, output, oldBoard }: ReadOnlyBoardChromeProps) {
    const [pagesOpen, setPagesOpen] = useState(false);
    const commands = useMemo(() => ({
        actionLabel: (id: MainAction) => ZOOM_LABELS[id] ?? id,
        actionShortcut: () => undefined,
        actionState: (id: MainAction): CommandState => {
            const operation = id in ZOOM_LABELS ? camera[id as keyof typeof camera] : undefined;
            return operation && typeof operation === 'object' ? operation.state() : UNAVAILABLE;
        },
        runAction: (id: MainAction) => {
            const operation = id in ZOOM_LABELS ? camera[id as keyof typeof camera] : undefined;
            if (operation && typeof operation === 'object' && operation.state().enabled) {
                void Promise.resolve(operation.run()).catch(error => {
                    if (!(error instanceof DOMException && error.name === 'AbortError')) console.error('Board view action failed:', error);
                });
            }
        },
    }), [camera]);
    const current = sheets.find(item => item.id === sheet) ?? sheets[0];
    const noun = oldBoard?.kind ?? (kind === 'notebook' ? 'notebook' : 'drawing');
    const explanation = `This ${noun} was made with an older version of the app. It is shown exactly as it was, and it is never changed here. `
        + 'Make an editable copy to work on it: the copy is made beside it in the same folder, and the original stays as it is.';
    const invertLabel = inverted ? 'Show page colours as they are' : 'Invert page colours';
    const mac = /Mac|iPhone|iPad/.test(navigator.platform);
    // The editing menu's place and look (BoardHeader.tsx), holding only what reads the board. Copy, Select all and Copy as
    // PNG stay on their keys (⌘C, ⌘A, ⇧⌘C), which work here as they do while editing.
    const openMenu = (anchor: HTMLButtonElement) => {
        const rect = anchor.getBoundingClientRect();
        const dark = anchor.closest('[data-board-theme="dark"]') !== null;
        const notReady = 'The board is still opening';
        openContextMenu({ x: rect.left, y: rect.bottom, anchor, opener: anchor, label: 'Board menu',
            className: dark ? 'board-main-menu board-main-menu-dark' : 'board-main-menu',
            entries: [
                { kind: 'command', id: 'print', label: 'Print…', shortcut: mac ? '⌘P' : 'Ctrl+P',
                    disabled: !output, reason: output ? undefined : notReady, run: () => { output?.print(); } },
                { kind: 'command', id: 'export-pdf', label: 'Export to PDF',
                    disabled: !output, reason: output ? undefined : notReady, run: () => { output?.exportPdf(); } },
            ] });
    };
    return <div className="board-chrome-overlay board-readonly-chrome">
        <div className="board-chrome-top">
            <div className="board-chrome-header">
                <div className="board-chrome-strip" role="toolbar" aria-label={oldBoard ? `Older ${noun}` : 'Board view'}>
                    <button type="button" className="board-chrome-strip-button" aria-label="Board menu" data-tooltip="Board menu"
                        aria-haspopup="menu" onClick={event => openMenu(event.currentTarget)}>
                        <LucideGlyph nodes={headerIcons.menu} size={16} /></button>
                    {kind === 'whiteboard' && sheets.length > 1 && current && <button type="button" className="board-chrome-sheet"
                        aria-haspopup="menu" onClick={event => {
                            const anchor = event.currentTarget, rect = anchor.getBoundingClientRect();
                            const dark = anchor.closest('[data-board-theme="dark"]') !== null;
                            openContextMenu({ x: rect.left, y: rect.bottom, anchor, opener: anchor, label: 'Sheets',
                                className: dark ? 'board-main-menu board-main-menu-dark' : 'board-main-menu',
                                entries: sheets.map(item => ({ kind: 'command' as const, id: `sheet:${item.id}`, label: item.name,
                                    checked: item.id === current.id, run: () => setSheet(item.id) })) });
                        }}><span>{current.name}</span><LucideGlyph nodes={headerIcons.chevronDown} size={16} /></button>}
                    {thumbnails && <button type="button" className="board-chrome-strip-button" aria-label="Page thumbnails"
                        data-tooltip="Page thumbnails" aria-pressed={pagesOpen} aria-expanded={pagesOpen}
                        onClick={() => setPagesOpen(!pagesOpen)}><LucideGlyph nodes={readOnlyIcons.pages} size={16} /></button>}
                    {kind === 'notebook' && <button type="button" className="board-chrome-strip-button" aria-label={invertLabel}
                        data-tooltip={invertLabel} aria-pressed={inverted} onClick={() => setInverted(!inverted)}>
                        <LucideGlyph nodes={readOnlyIcons.invert} size={16} /></button>}
                    {oldBoard && <>
                        <span className="board-readonly-note" data-tooltip={explanation}>
                            <LucideGlyph nodes={readOnlyIcons.lock} size={14} />
                            <span>Older version · view only</span>
                        </span>
                        <button type="button" className="board-readonly-copy" disabled={oldBoard.copying} aria-busy={oldBoard.copying}
                            aria-label={oldBoard.copying ? 'Making an editable copy' : 'Make an editable copy'}
                            data-tooltip={oldBoard.copying ? undefined : explanation} onClick={event => oldBoard.onCopy(event.currentTarget)}>
                            <LucideGlyph nodes={readOnlyIcons.copyPlus} size={15} />
                            <span>{oldBoard.copying ? 'Making a copy…' : 'Make an editable copy'}</span>
                        </button>
                    </>}
                </div>
            </div>
            {thumbnails?.(pagesOpen, setPagesOpen)}
        </div>
        <div className="board-chrome-middle" />
        <div className="board-chrome-bottom">
            <div className="board-chrome-zoom">
                <ZoomControls zoom={zoom} locale="en" direction="ltr" zoomLabel="Zoom" minimapLabel="Minimap"
                    minimapVisible={kind === 'whiteboard' && minimapOpen} commands={commands} />
            </div>
        </div>
    </div>;
}
