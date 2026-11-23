import { getBoardPreferences, updateBoardPreferences } from '../../utils/boardPreferences';
import type { BoardPreferenceState } from '../../whiteboard/chrome/preferences';
import type { BoardRuntime } from '../../whiteboard/host/runtime';
import { createStructureCommands } from '../../whiteboard/host/structureCommands';
import { NEW_SHEET_NAME } from '../../whiteboard/host/structureControls';
import { childrenOf } from '../../whiteboard/model/doc';
import type { createNativeCameraOperations } from './nativeCameraOperations';
import type { createNativeCommandSource } from './nativeCommandSource';
import type { NativeViewLease } from './nativeViewLease';
import { focusStylePanel } from './chrome/stylePanelStore';

/** Additional keyboard bindings use the same live commands, camera and preferences as chrome. */
export function createNativeEditingKeyboard(options: {
    readonly runtime: BoardRuntime;
    readonly lease: NativeViewLease;
    readonly commands: ReturnType<typeof createNativeCommandSource>;
    readonly camera: ReturnType<typeof createNativeCameraOperations>;
    readonly preferences: BoardPreferenceState;
    readonly openShortcuts: () => boolean;
    /** Inverts the one picture selected; false when none is, so the key does nothing. */
    readonly invertPicture: () => boolean;
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
    const sheetCommands = createStructureCommands({ runtime: options.runtime, geometry: options.runtime.render.changeGeometry,
        current: () => options.current() && options.canWrite() && !options.runtime.session.isGestureActive,
        confirm: async () => false, onError: options.report });
    /** Forward past the last sheet creates one only from a nonempty sheet, the same settled cap as the sheet menu (F-SHEET-002). */
    const stepSheet = (step: 1 | -1): boolean => {
        const { session } = options.runtime, sheets = session.doc.sheetOrder;
        const index = sheets.findIndex(sheet => sheet.id === options.runtime.selection.getSnapshot().sheet);
        if (index < 0) return false;
        const next = sheets[index + step];
        if (next) { options.runtime.selection.setSheet(next.id); return true; }
        const last = sheets[index];
        if (step < 0 || session.isReadOnly || !options.canWrite() || session.isGestureActive || sheets.length >= 40
            || childrenOf(session.doc, last.id).length === 0) return false;
        const created = sheetCommands.addSheet(NEW_SHEET_NAME);
        if (!created) return false;
        options.runtime.selection.setSheet(created); return true;
    };
    return (id: string): boolean => {
        if (!options.current()) return false;
        switch (id) {
            case 'figure.rectangle': case 'figure.ellipse': case 'figure.last': {
                if (!options.canWrite() || !options.runtime.tools.getRegistration('figure')) return false;
                const variant = id === 'figure.last' ? options.runtime.tools.getSnapshot().lastFigure ?? 'rectangle' : id.slice('figure.'.length);
                options.runtime.tools.setTool('figure', variant); return true;
            }
            case 'style.adjust': return focusStylePanel();
            case 'sheet.previous': return stepSheet(-1);
            case 'sheet.next': return stepSheet(1);
            // Mod+Alt+G removes a selection of frames and frames any other selection (F-FRAME-004/005).
            case 'frame.toggle': {
                const command = options.commands.state('removeFrame').enabled ? 'removeFrame' : 'frameSelection';
                if (!options.commands.state(command).enabled) return false;
                void options.commands.run(command); return true;
            }
            case 'camera.zoomIn': return runAction('zoomIn');
            case 'camera.zoomOut': return runAction('zoomOut');
            case 'camera.reset': return runAction('zoomTo100');
            case 'camera.fit': return runAction('zoomToFit');
            case 'camera.selection': return runAction('zoomToSelection');
            case 'camera.zoomInCursor': return options.camera.zoomAtCursor(1);
            case 'camera.zoomOutCursor': return options.camera.zoomAtCursor(-1);
            case 'media.insert': return runAction('uploadMedia');
            case 'embed.insert': return runAction('insertEmbed');
            case 'media.invert': return options.invertPicture();
            case 'help.shortcuts': return options.openShortcuts();
            case 'accessibility.repeat': return options.lease.editing?.repeatAnnouncement() ?? false;
            case 'preferences.theme': {
                const theme = getBoardPreferences().colorScheme;
                // System follows the app theme (absent data-theme = dark), the same resolution the pane draws with.
                const dark = theme === 'system' ? document.documentElement.getAttribute('data-theme') !== 'light' : theme === 'dark';
                updateBoardPreferences({ colorScheme: dark ? 'light' : 'dark' }); return true;
            }
            case 'preferences.focus': case 'preferences.grid': {
                if (!options.canWrite() || options.runtime.session.isGestureActive) return false;
                const key = id === 'preferences.focus' ? 'focusMode' : 'grid';
                options.preferences.setView(key, !options.preferences.getSnapshot().view[key]); return true;
            }
            default: return false;
        }
    };
}
