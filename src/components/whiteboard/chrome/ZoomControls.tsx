import { useEffect, useRef } from 'react';
import { getContextMenu, openContextMenu, replaceContextMenuEntries, type ContextMenuEntry } from '../../../utils/contextMenu';
import LucideGlyph from '../../LucideGlyph';
import type { MainAction, MainMenuSource } from './mainMenu';
import { navigationIcons } from './boardIcons';
import './chrome.css';

export interface ZoomControlsProps {
    readonly zoom: number;
    readonly locale: string;
    readonly direction: 'ltr' | 'rtl';
    readonly zoomLabel: string;
    readonly minimapLabel: string;
    readonly minimapVisible: boolean;
    readonly commands: Pick<MainMenuSource, 'actionLabel' | 'actionShortcut' | 'actionState' | 'runAction'>;
}

/** The zoom menu's rows, in tldraw's order. They keep the menu open, so each one is re-read when the zoom moves. */
const zoomRows: readonly MainAction[] = ['zoomTo100', 'zoomToFit', 'zoomToSelection'];

/** The navigation panel: zoom out and in, the zoom menu and the minimap chevron. Zoom out and in show only while the
 * minimap is open, so a collapsed map leaves the bar as a single percentage and its chevron (the default look). */
export function ZoomControls({ zoom, locale, direction, zoomLabel, minimapLabel, minimapVisible, commands }: ZoomControlsProps) {
    const anchor = useRef<HTMLButtonElement | null>(null);
    const percent = Math.round(zoom * 100);
    const zoomText = `${zoomLabel} — ${percent}%`;
    const row = (id: MainAction): ContextMenuEntry => {
        const state = commands.actionState(id);
        return { kind: 'command', id, label: commands.actionLabel(id), shortcut: commands.actionShortcut(id),
            disabled: !state.enabled, reason: state.enabled ? undefined : state.reason, keepOpen: true,
            run: () => commands.runAction(id) };
    };
    const zoomMenu = (): ContextMenuEntry[] => [row('zoomIn'), row('zoomOut'), ...zoomRows.map(row)];
    // An open zoom menu reads its rows live: Zoom to 100% is offered only away from 100%, and a zoom step changes that.
    useEffect(() => {
        const element = anchor.current;
        if (element && getContextMenu()?.anchor === element) replaceContextMenuEntries(element, zoomMenu());
    });
    const minimapState = commands.actionState('toggleMinimap');
    // The chevron points where the map would go: right while collapsed on a left-to-right board, and mirrored on RTL.
    const pointsRight = !minimapVisible !== (direction === 'rtl');
    const minimap = <button key="minimap" type="button" className="board-chrome-tool board-chrome-icon" aria-label={minimapLabel}
        data-tooltip={minimapState.enabled ? minimapLabel : minimapState.reason} disabled={!minimapState.enabled}
        aria-pressed={minimapVisible} onClick={() => void commands.runAction('toggleMinimap')}>
        <LucideGlyph nodes={pointsRight ? navigationIcons.chevronRight : navigationIcons.chevronLeft} size={16} />
    </button>;
    const step = (id: 'zoomIn' | 'zoomOut') => {
        const state = commands.actionState(id);
        return <button key={id} type="button" className="board-chrome-tool board-chrome-icon" aria-label={commands.actionLabel(id)}
            data-tooltip={state.enabled ? commands.actionLabel(id) : state.reason} disabled={!state.enabled}
            onClick={() => void commands.runAction(id)}>
            <LucideGlyph nodes={navigationIcons[id]} size={16} />
        </button>;
    };
    const percentButton = <button key="zoom" ref={anchor} type="button" className="board-chrome-tool board-chrome-zoom-value"
        aria-label={zoomText} data-tooltip={zoomText} aria-haspopup="menu"
        onDoubleClick={() => void commands.runAction('zoomTo100')}
        onClick={event => {
            const element = event.currentTarget;
            const rect = element.getBoundingClientRect();
            // The menu sits above the control with an 8px gap, as tldraw's zoom popover does.
            openContextMenu({ x: rect.left, y: rect.top - 8, anchor: element, opener: element, label: zoomLabel, lang: locale,
                dir: direction, above: true, entries: zoomMenu() });
        }}>{percent}%</button>;
    // The minimap chevron stands at the outer end (left on RTL). Zoom out and in flank the percentage while the map is open.
    const rtl = direction === 'rtl';
    const items = !minimapVisible ? (rtl ? [minimap, percentButton] : [percentButton, minimap])
        : rtl ? [minimap, step('zoomOut'), percentButton, step('zoomIn')] : [step('zoomOut'), percentButton, step('zoomIn'), minimap];
    return <div className="board-chrome-tool-row board-chrome-zoom-row">{items}</div>;
}
