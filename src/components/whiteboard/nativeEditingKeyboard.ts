import { getBoardPreferences, updateBoardPreferences } from '../../utils/boardPreferences';
import type { BoardPreferenceState } from '../../whiteboard/chrome/preferences';
import type { BoardRuntime } from '../../whiteboard/host/runtime';
import type { createBoardStyleControls } from '../../whiteboard/host/styleControls';
import { FILLS } from '../../whiteboard/model/styles';
import type { createNativeCameraOperations } from './nativeCameraOperations';
import type { createNativeCommandSource } from './nativeCommandSource';
import type { NativeViewLease } from './nativeViewLease';

/** Additional keyboard bindings use the same live commands, camera and style controller as chrome. */
export function createNativeEditingKeyboard(options: {
    readonly runtime: BoardRuntime;
    readonly lease: NativeViewLease;
    readonly commands: ReturnType<typeof createNativeCommandSource>;
    readonly camera: ReturnType<typeof createNativeCameraOperations>;
    readonly preferences: BoardPreferenceState;
    readonly styles: () => ReturnType<typeof createBoardStyleControls> | null;
    readonly openShortcuts: () => boolean;
    readonly current: () => boolean;
    readonly canWrite: () => boolean;
    readonly report: (error: unknown) => void;
}) {
    const runAction = (id: Parameters<typeof options.commands.runAction>[0]) => {
        if (!options.commands.actionState(id).enabled) return false;
        const result = options.commands.runAction(id);
        if (result) void result.catch(options.report);
        return true;
    };
    return (id: string): boolean => {
        if (!options.current()) return false;
        switch (id) {
            case 'figure.rectangle': case 'figure.ellipse': case 'figure.last': {
                if (!options.canWrite() || !options.runtime.tools.getRegistration('figure')) return false;
                const variant = id === 'figure.last' ? options.runtime.tools.getSnapshot().lastFigure ?? 'rectangle' : id.slice('figure.'.length);
                options.runtime.tools.setTool('figure', variant); return true;
            }
            case 'sheet.previous': case 'sheet.next': {
                const sheets = options.runtime.session.doc.sheetOrder;
                const index = sheets.findIndex(sheet => sheet.id === options.runtime.selection.getSnapshot().sheet);
                const next = sheets[index + (id === 'sheet.next' ? 1 : -1)];
                if (index < 0 || !next) return false;
                options.runtime.selection.setSheet(next.id); return true;
            }
            case 'camera.zoomIn': return runAction('zoomIn');
            case 'camera.zoomOut': return runAction('zoomOut');
            case 'camera.reset': return runAction('zoomTo100');
            case 'camera.fit': return runAction('zoomToFit');
            case 'camera.selection': return runAction('zoomToSelection');
            case 'camera.zoomInCursor': return options.camera.zoomAtCursor(1.2);
            case 'camera.zoomOutCursor': return options.camera.zoomAtCursor(1 / 1.2);
            case 'media.insert': return runAction('uploadMedia');
            case 'help.shortcuts': return options.openShortcuts();
            case 'accessibility.repeat': return options.lease.editing?.repeatAnnouncement() ?? false;
            case 'preferences.theme': {
                const theme = getBoardPreferences().colorScheme;
                const dark = theme === 'system' ? matchMedia('(prefers-color-scheme: dark)').matches : theme === 'dark';
                updateBoardPreferences({ colorScheme: dark ? 'light' : 'dark' }); return true;
            }
            case 'preferences.focus': case 'preferences.grid': {
                if (!options.canWrite()) return false;
                const key = id === 'preferences.focus' ? 'focusMode' : 'grid';
                options.preferences.setView(key, !options.preferences.getSnapshot().view[key]); return true;
            }
            case 'style.white': case 'style.fill': case 'style.linedFill': case 'style.sample': {
                const styles = options.styles();
                if (!styles || !options.canWrite()) return false;
                if (id === 'style.white') styles.commands.setColor('white');
                else if (id === 'style.linedFill') styles.commands.setFill('lined-fill');
                else if (id === 'style.fill') {
                    const fill = options.runtime.session.doc.ui.next.fill;
                    styles.commands.setFill(FILLS[(FILLS.indexOf(fill) + 1) % FILLS.length]);
                } else {
                    const selected = options.runtime.selection.getSnapshot().selected;
                    if (selected.length !== 1) return false;
                    styles.commands.sampleStyle(selected[0]);
                }
                return true;
            }
            default: return false;
        }
    };
}
