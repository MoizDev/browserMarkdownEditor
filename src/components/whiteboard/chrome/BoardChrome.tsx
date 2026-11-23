import type { ReactNode } from 'react';
import { BoardHeader, type BoardHeaderProps } from './BoardHeader';
import { ToolStrip, type ToolChoice } from './ToolStrip';
import { toolChoices, type ToolLabel } from './toolChoices';
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
    readonly selectTool: (choice: ToolChoice) => void;
    readonly zoomControls: ZoomControlsProps;
    readonly stylePanel?: StylePanelProps;
    readonly debug?: DebugOverlayProps;
    /** Paper controls of a paged host; they sit under the header, never over it. */
    readonly pageControls?: ReactNode;
}

/** The view supplies live session state; these controls do not own a second selection or history. */
export function BoardChrome({ locale, direction, selectedTool, toolLabel, toolShortcut, toolsLabel, moreLabel,
    readOnly, readOnlyReason, toolDisabledReason, focusMode, selectTool, zoomControls, stylePanel, debug, pageControls, ...header }: BoardChromeProps) {
    const choices = toolChoices(toolLabel, toolShortcut);
    return <>
        {debug && <DebugOverlay {...debug} />}
        {!focusMode && <div className="board-chrome-overlay" lang={locale} dir={direction}>
        <div className="board-chrome-top">
            <BoardHeader {...header} locale={locale} direction={direction} />
            {pageControls}
            {stylePanel && <div className="board-chrome-pen"><DockedStylePanel {...stylePanel} /></div>}
        </div>
        <div className="board-chrome-bottom">
            {stylePanel && <StylePopoverAnchor {...stylePanel} />}
            <ToolStrip primary={choices.primary} more={choices.more} selected={selectedTool}
                toolsLabel={toolsLabel} moreLabel={moreLabel}
                disabledReason={choice => readOnly && choice.id !== 'select' && choice.id !== 'hand'
                    ? (readOnlyReason ?? moreLabel) : toolDisabledReason?.(choice)} select={selectTool} />
            <div className="board-chrome-zoom"><ZoomControls {...zoomControls} /></div>
        </div>
    </div>}
    </>;
}
