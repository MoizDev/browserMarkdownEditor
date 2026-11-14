import { BoardHeader, type BoardHeaderProps } from './BoardHeader';
import { ToolStrip, type ToolChoice } from './ToolStrip';
import { toolChoices, type ToolLabel } from './toolChoices';
import { ZoomControls, type ZoomControlsProps } from './ZoomControls';
import { ConnectedPenPanel, type ConnectedPenPanelProps } from './ConnectedPenPanel';
import { DebugOverlay, type DebugOverlayProps } from './DebugOverlay';
import './chrome.css';

export interface BoardChromeProps extends BoardHeaderProps {
    readonly locale: string;
    readonly direction: 'ltr' | 'rtl';
    readonly selectedTool: ToolChoice;
    readonly lastFigure: string;
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
    readonly penPanel?: ConnectedPenPanelProps;
    readonly debug?: DebugOverlayProps;
}

/** The view supplies live session state; these controls do not own a second selection or history. */
export function BoardChrome({ locale, direction, selectedTool, lastFigure, toolLabel, toolShortcut, toolsLabel, moreLabel,
    readOnly, readOnlyReason, toolDisabledReason, focusMode, selectTool, zoomControls, penPanel, debug, ...header }: BoardChromeProps) {
    const choices = toolChoices(toolLabel, toolShortcut, lastFigure);
    return <>
        {debug && <DebugOverlay {...debug} />}
        {!focusMode && <div className="board-chrome-overlay" lang={locale} dir={direction}>
        <BoardHeader {...header} locale={locale} direction={direction} />
        {penPanel && <div className="board-chrome-pen"><ConnectedPenPanel {...penPanel} /></div>}
        <div className="board-chrome-bottom">
            <ToolStrip primary={choices.primary} more={choices.more} selected={selectedTool}
                toolsLabel={toolsLabel} moreLabel={moreLabel}
                disabledReason={choice => readOnly && choice.id !== 'select' && choice.id !== 'hand'
                    ? (readOnlyReason ?? moreLabel) : toolDisabledReason?.(choice)} select={selectTool} />
            <div className="board-chrome-zoom"><ZoomControls {...zoomControls} /></div>
        </div>
    </div>}
    </>;
}
