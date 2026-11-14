import { BoardHeader, type BoardHeaderProps } from './BoardHeader';
import { ToolStrip, type ToolChoice } from './ToolStrip';
import { toolChoices, type ToolLabel } from './toolChoices';
import { ZoomControls, type ZoomControlsProps } from './ZoomControls';
import { ConnectedPenPanel, type ConnectedPenPanelProps } from './ConnectedPenPanel';
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
    readonly focusMode?: boolean;
    readonly selectTool: (choice: ToolChoice) => void;
    readonly zoomControls: ZoomControlsProps;
    readonly penPanel?: ConnectedPenPanelProps;
}

/** The view supplies live session state; these controls do not own a second selection or history. */
export function BoardChrome({ locale, direction, selectedTool, lastFigure, toolLabel, toolShortcut, toolsLabel, moreLabel,
    readOnly, focusMode, selectTool, zoomControls, penPanel, ...header }: BoardChromeProps) {
    const choices = toolChoices(toolLabel, toolShortcut, lastFigure);
    if (focusMode) return null;
    return <div className="board-chrome-overlay" lang={locale} dir={direction}>
        <BoardHeader {...header} />
        {penPanel && <div className="board-chrome-pen"><ConnectedPenPanel {...penPanel} /></div>}
        <div className="board-chrome-bottom">
            <ToolStrip primary={choices.primary} more={choices.more} selected={selectedTool}
                toolsLabel={toolsLabel} moreLabel={moreLabel} disabled={readOnly} select={selectTool} />
            <div className="board-chrome-zoom"><ZoomControls {...zoomControls} /></div>
        </div>
    </div>;
}
