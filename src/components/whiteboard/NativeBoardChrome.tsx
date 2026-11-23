import { useCallback, useEffect, useLayoutEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { availableBoardLocales, translateBoard, type BoardLanguageState } from '../../whiteboard/chrome/language';
import type { BoardPreferenceState } from '../../whiteboard/chrome/preferences';
import { createBoardStyleControls } from '../../whiteboard/host/styleControls';
import type { BoardRuntime } from '../../whiteboard/host/runtime';
import { bindingChord, boardBindings, shortcutGroups } from '../../whiteboard/input/keyboard';
import type { ViewerEngine } from '../../whiteboard/viewer/types';
import { persistLastPenScale } from './chrome/penPanelStore';
import { SessionBoardChrome, type SessionBoardChromeProps } from './chrome/SessionBoardChrome';

type Supplied = Omit<SessionBoardChromeProps, 'kind' | 'locale' | 'direction' | 'translate' | 'languages' | 'selectLanguage'
    | 'toolState' | 'toolShortcut' | 'shortcuts' | 'localPreferences' | 'penPanel'>;
export interface NativeBoardChromeProps extends Supplied {
    readonly runtime: BoardRuntime;
    readonly engine: ViewerEngine;
    readonly language: BoardLanguageState;
    readonly preferences: BoardPreferenceState;
    readonly currentOwner: () => boolean;
    readonly mac: boolean;
    readonly onReady: (ready: boolean) => void;
    readonly onStyles: (styles: Styles | null) => void;
}
type Styles = ReturnType<typeof createBoardStyleControls>;

/** Chrome observes the exact document-owned tool, selection, preferences and view. */
export function NativeBoardChrome(props: NativeBoardChromeProps) {
    const { runtime, engine, language, currentOwner, reportError, onStyles } = props;
    const tools = useMemo(() => ({ getSnapshot: runtime.tools.getSnapshot, subscribe: runtime.tools.subscribe,
        setTool(id: string, variant?: string) { if (currentOwner()) runtime.tools.setTool(id, variant); } }), [runtime, currentOwner]);
    if (engine.session !== runtime.session) throw new Error('Board chrome needs the attached board session');
    const [owned, setOwned] = useState<{ runtime: BoardRuntime; engine: ViewerEngine; language: BoardLanguageState; styles: Styles } | null>(null);
    useEffect(() => {
        const styles = createBoardStyleControls({ runtime, tool: runtime.tools, language,
            palette: () => engine.getSnapshot().palette, panelBackground: () => engine.getSnapshot().palette.background,
            subscribeAppearance: listener => engine.subscribe(listener), currentOwner, persistScale: persistLastPenScale, onError: reportError });
        setOwned({ runtime, engine, language, styles }); onStyles(styles);
        return () => { onStyles(null); styles.dispose(); };
    }, [runtime, engine, language, currentOwner, reportError, onStyles]);
    if (!owned || owned.runtime !== runtime || owned.engine !== engine || owned.language !== language) return null;
    return <AttachedNativeBoardChrome {...props} styles={owned.styles} tools={tools} />;
}

function AttachedNativeBoardChrome({ runtime, language, preferences, mac, onReady, onStyles: _onStyles, styles, tools, ...props }: NativeBoardChromeProps & {
    styles: Styles; tools: Pick<NativeBoardChromeProps['runtime']['tools'], 'getSnapshot' | 'subscribe' | 'setTool'>;
}) {
    const lang = useSyncExternalStore(language.subscribe, language.getSnapshot, language.getSnapshot);
    const local = useSyncExternalStore(preferences.subscribe, preferences.getSnapshot, preferences.getSnapshot);
    const panel = useSyncExternalStore(styles.subscribe, styles.getSnapshot, styles.getSnapshot);
    // The commands a gesture holds (undo, redo, delete, …) are read as the chrome renders, so it renders when a gesture starts and
    // ends. Without this they showed whatever the last unrelated render saw: Undo stayed lit through a shape's creation drag on
    // canvas2d once a pan or a press stopped asking for a new paint (and with it the view's re-render).
    const session = runtime.session;
    const subscribeGesture = useCallback((listener: () => void) => session.subscribeGesture(listener), [session]);
    const gestureActive = useCallback(() => session.isGestureActive, [session]);
    useSyncExternalStore(subscribeGesture, gestureActive, gestureActive);
    useLayoutEffect(() => { if (!props.isVisible) { onReady(false); return; }
        onReady(true); return () => onReady(false); }, [onReady, styles, props.isVisible]);
    useEffect(() => { styles.refresh(); }, [props.readOnly, styles]);
    useEffect(() => { if (!props.isVisible) styles.finish(); }, [props.isVisible, styles]);
    const tooltip = (id: string, figure?: string) => {
        const key = id === 'figure' ? `figure.${figure ?? runtime.tools.getSnapshot().lastFigure ?? 'rectangle'}` : `tool.${id}`;
        const binding = boardBindings.find(item => item.id === key);
        return binding ? bindingChord(binding, mac) : undefined;
    };
    return <SessionBoardChrome {...props} kind={runtime.session.doc.kind} locale={lang.locale} direction={lang.table.dir}
        translate={(key, values) => translateBoard(lang.table, key, values)} languages={availableBoardLocales()}
        selectLanguage={locale => language.select(locale)} toolState={tools} toolShortcut={tooltip} shortcuts={shortcutGroups(mac, runtime.session.doc.kind !== 'whiteboard')}
        localPreferences={{ ...local, setView: (key, value) => { if (props.currentOwner()) preferences.setView(key, value); },
            setSession: (key, value) => preferences.setSession(key, value) }} penPanel={panel} />;
}
