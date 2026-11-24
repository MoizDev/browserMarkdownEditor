import type { ReactNode } from 'react';
import { BoardHeader, type BoardHeaderProps } from './BoardHeader';
import { ToolStrip, type ToolChoice, type ToolLockView } from './ToolStrip';
import { chordLabel, toolChoices, type ToolLabel } from './toolChoices';
import { ZoomControls, type ZoomControlsProps } from './ZoomControls';
import { DockedStylePanel, StylePopoverAnchor, type StylePanelProps } from './StylePanel';
import { DebugOverlay, type DebugOverlayProps } from './DebugOverlay';
import './chrome.css';

export interface BoardChromeProps extends BoardHeaderProps {
    readonly locale: string;
    readonly direction: 'ltr' | 'rtl';
    readonly selectedTool: ToolChoice;
    readonly toolLabel: (key: ToolLabel) => string;
    readonly toolShortcut: (id: string, figure?: string) => string | undefined;
    readonly toolsLabel: string;
    readonly moreLabel: string;
    readonly readOnly: boolean;
    readonly readOnlyReason?: string;
    readonly toolDisabledReason?: (choice: ToolChoice) => string | undefined;
    readonly focusMode?: boolean;
    /** Focus mode's one button puts the chrome back; its label is the mode's own, with its chord. */
    readonly focusModeLabel: string;
    readonly exitFocusMode: () => void;
    /** The bar's figure slot: the figure last drawn with (rectangle until one is chosen). */
    readonly lastFigure?: string;
    /** The tool lock, while the selected tool can be locked; `toolLockLabel` names it. */
    readonly toolLockLabel: string;
    readonly toolLock?: { readonly locked: boolean; readonly toggle: () => void };
    readonly onBarTools?: (shown: readonly ToolChoice[]) => void;
    readonly selectTool: (choice: ToolChoice) => void;
    /** A bar tool dragged onto the board; the board answers whether it took the press. */
    readonly dragTool?: (choice: ToolChoice, event: PointerEvent, bar: Element) => boolean;
    readonly zoomControls: ZoomControlsProps;
    readonly stylePanel?: StylePanelProps;
    readonly debug?: DebugOverlayProps;
    /** Paper controls of a paged host; they sit under the header, never over it. */
    readonly pageControls?: ReactNode;
    /** The command palette; it sits between the header and the bar, above the bar when open. */
    readonly palette?: ReactNode;
}

/** The view supplies live session state; these controls do not own a second selection or history. */
export function BoardChrome({ locale, direction, selectedTool, toolLabel, toolShortcut, toolsLabel, moreLabel,
    readOnly, readOnlyReason, toolDisabledReason, focusMode, focusModeLabel, exitFocusMode, lastFigure, toolLockLabel, toolLock,
    onBarTools, selectTool, dragTool, zoomControls, stylePanel, debug, pageControls, palette, ...header }: BoardChromeProps) {
    const choices = toolChoices(toolLabel, toolShortcut, lastFigure);
    const lock: ToolLockView | undefined = toolLock && {
        locked: toolLock.locked, label: toolLockLabel, shortcut: toolShortcut('lock'), toggle: toolLock.toggle,
        disabledReason: readOnly ? (readOnlyReason ?? toolLockLabel) : undefined,
    };
    return <>
        {debug && <DebugOverlay {...debug} />}
        {focusMode && <div className="board-chrome-overlay board-chrome-focus-overlay" lang={locale} dir={direction}>
            <button type="button" className="board-chrome-focus" aria-label={chordLabel(focusModeLabel, toolShortcut('preferences.focus'))}
                data-tooltip={chordLabel(focusModeLabel, toolShortcut('preferences.focus'))} onClick={exitFocusMode}><span aria-hidden="true" /></button>
        </div>}
        {!focusMode && <div className="board-chrome-overlay" lang={locale} dir={direction}>
        <div className="board-chrome-top">
            <BoardHeader {...header} locale={locale} direction={direction} />
            {pageControls}
        </div>
        {/* The middle row is what the header and the bottom row leave. The docked panel is a flow column in it, so it gets the height
            the bottom row, the notices and an open minimap leave free (chrome.css .board-chrome-pen). The palette lays over the
            row instead of taking a place in the column: as a flow child it shrank the panel, which then jumped and clipped
            (measured: the panel's box went from y 118, h 562 to y 536, h 144, when the palette opened). */}
        <div className="board-chrome-middle">
            {stylePanel && <div className="board-chrome-pen"><DockedStylePanel {...stylePanel} /></div>}
            {palette}
        </div>
        <div className="board-chrome-bottom">
            {stylePanel && <StylePopoverAnchor {...stylePanel} />}
            <ToolStrip primary={choices.primary} more={choices.more} selected={selectedTool} lock={lock} onShown={onBarTools}
                toolsLabel={toolsLabel} moreLabel={moreLabel}
                disabledReason={choice => readOnly && choice.id !== 'select' && choice.id !== 'hand'
                    ? (readOnlyReason ?? moreLabel) : toolDisabledReason?.(choice)} select={selectTool} dragTool={dragTool} />
            <div className="board-chrome-zoom"><ZoomControls {...zoomControls} /></div>
        </div>
    </div>}
    </>;
}
