import { openContextMenu } from '../../../utils/contextMenu';
import type { MainAction, MainMenuSource } from './mainMenu';
import './chrome.css';

export interface ZoomControlsProps {
    readonly zoom: number;
    readonly zoomLabel: string;
    readonly minimapLabel: string;
    readonly minimapVisible: boolean;
    readonly commands: Pick<MainMenuSource, 'actionLabel' | 'actionShortcut' | 'actionState' | 'runAction'>;
}

export function ZoomControls({ zoom, zoomLabel, minimapLabel, minimapVisible, commands }: ZoomControlsProps) {
    const ids: readonly MainAction[] = ['zoomIn', 'zoomOut', 'zoomToFit', 'zoomToSelection', 'zoomTo100'];
    const minimapState = commands.actionState('toggleMinimap');
    return <div className="board-chrome-tool-row">
        <button type="button" className="board-chrome-tool" aria-label={`${zoomLabel}: ${Math.round(zoom * 100)}%`}
            data-tooltip={zoomLabel} aria-haspopup="menu" onClick={event => {
                const anchor = event.currentTarget;
                const rect = anchor.getBoundingClientRect();
                openContextMenu({ x: rect.left, y: rect.top, anchor, opener: anchor, label: zoomLabel,
                    entries: ids.map(id => {
                        const state = commands.actionState(id);
                        return { kind: 'command', id, label: commands.actionLabel(id), shortcut: commands.actionShortcut(id),
                            disabled: !state.enabled, reason: state.enabled ? undefined : state.reason,
                            run: () => commands.runAction(id) };
                    }) });
            }}>{Math.round(zoom * 100)}%</button>
        <button type="button" className="board-chrome-tool" aria-label={minimapLabel}
            data-tooltip={minimapState.enabled ? minimapLabel : minimapState.reason}
            disabled={!minimapState.enabled} aria-pressed={minimapVisible}
            onClick={() => void commands.runAction('toggleMinimap')}>{minimapLabel}</button>
    </div>;
}
