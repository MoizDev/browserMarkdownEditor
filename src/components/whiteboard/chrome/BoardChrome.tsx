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
    readonly focusModeLabel: string;
    readonly exitFocusMode: () => void;
    readonly lastFigure?: string;
    readonly toolLockLabel: string;
    readonly toolLock?: { readonly locked: boolean; readonly toggle: () => void };
    readonly onBarTools?: (shown: readonly ToolChoice[]) => void;
    readonly selectTool: (choice: ToolChoice) => void;
    readonly dragTool?: (choice: ToolChoice, event: PointerEvent, bar: Element) => boolean;
    readonly zoomControls: ZoomControlsProps;
    readonly stylePanel?: StylePanelProps;
    readonly debug?: DebugOverlayProps;
    readonly pageControls?: ReactNode;
    readonly palette?: ReactNode;
}

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
