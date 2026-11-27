import { isLocked } from '../../whiteboard/change/commands';
import { createArrangementCommandOperations } from '../../whiteboard/host/arrangementCommandOperations';
import { createEditCommandOperations } from '../../whiteboard/host/editCommandOperations';
import type { BoardRuntime } from '../../whiteboard/host/runtime';
import type { BoardCommand, CommandState } from './chrome/boardCommands';
import type { MainAction } from './chrome/mainMenu';
import { createNativeCommandSource, type NativeCommandOperation } from './nativeCommandSource';
import type { NativeViewLease } from './nativeViewLease';

const yes: CommandState = Object.freeze({ enabled: true });
const no = (reason: string): CommandState => ({ enabled: false, reason });

export function createNativeBoardOperations(options: {
    readonly runtime: BoardRuntime;
    readonly lease: NativeViewLease;
    readonly current: () => boolean;
    readonly canWrite: () => boolean;
    readonly frameName: () => string;
    readonly flatten: NativeCommandOperation;
    readonly editLink: NativeCommandOperation;
    readonly actions: Omit<Record<MainAction, NativeCommandOperation>, 'unlockAll'>;
    readonly label: (id: BoardCommand) => string;
    readonly shortcut: (id: BoardCommand) => string | undefined;
    readonly actionLabel: (id: MainAction) => string;
    readonly actionShortcut: (id: MainAction) => string | undefined;
    readonly notice: (message: string) => void;
    readonly pasteLanding: () => Promise<void> | null;
    readonly keptLockedNotice: (count: number) => string;
    readonly onError: (error: unknown) => void;
}) {
    const { runtime, lease } = options, session = runtime.session;
    if (lease.runtime !== runtime) throw new Error('Board commands need the attached session');
    const edit = createEditCommandOperations({ runtime, current: options.current, canWrite: options.canWrite,
        notice: options.notice, frameName: options.frameName, zoom: () => lease.camera.camera.z });
    const arrange = createArrangementCommandOperations({ runtime, current: options.current, canWrite: options.canWrite });
    const binding = () => lease.editing?.getBinding();
    const attached = (): CommandState => binding() ? yes : no('The board input is not attached');
    const selected = (): CommandState => {
        const state = attached();
        return state.enabled && !runtime.selection.getSnapshot().selected.length ? no('Select content first') : state;
    };
    const op = (state: () => CommandState, run: () => void | Promise<void>): NativeCommandOperation => ({ state, run });
    const clipboard = (action: 'copy' | 'cut' | 'duplicate' | 'copyAsPng' | 'copyAsSvg' | 'copyAsJson' | 'exportPng' | 'exportSvg' | 'exportJson',
        selection = false) => op(selection ? selected : attached, () => {
            const active = binding(); if (!active) throw new Error('The board input is not attached');
            return active.commands[action]();
        });
    const transform = (id: string, minimum: number) => op(() => {
        const state = attached(); if (!state.enabled) return state;
        const eligible = edit.frameSelection.state(); if (!eligible.enabled) return eligible;
        return runtime.selection.getSnapshot().selected.length >= minimum ? yes : no(`Select at least ${minimum} items`);
    }, () => {
        const select = lease.editing?.getTools()?.actualsubcontrollers.select;
        if (!select || !select.transform(id)) throw new Error('The selected content cannot be transformed');
    });
    const toggleAutoSize = (): NativeCommandOperation => {
        const fixedText = () => {
            const doc = session.doc;
            return runtime.selection.getSnapshot().selected.filter(id => {
                const node = doc.nodes.get(id);
                return node?.kind === 'text' && !node.autoSize && !isLocked(doc, node);
            });
        };
        return op(() => {
            const state = attached(); if (!state.enabled) return state;
            if (!options.canWrite() || session.isReadOnly) return no(session.readOnlyReason ?? 'The board is read-only');
            return fixedText().length ? yes : no('Select fixed-width text');
        }, () => {
            const ids = fixedText();
            if (!options.current() || !options.canWrite() || session.isReadOnly || !ids.length) throw new Error('The selected text cannot change size mode');
            session.history.open('Toggle auto size');
            try {
                const applied = session.apply({ origin: 'host', label: 'Toggle auto size',
                    ops: ids.map(id => ({ t: 'set' as const, id, key: 'autoSize', value: true })) });
                applied.release();
            } finally { session.history.close(); }
        });
    };
    // Undo and Redo from the header, the menu, the Styles panel or the palette act once a paste asked for before them has landed,
    // as ⌘Z does (attach.ts `runBound`): the paste was asked for first. Taken at once, Undo undid the step before the paste and
    // the paste then landed and emptied the redo, so that step could not be brought back (measured: 301 objects, ⌘V of all, header
    // Undo 44 ms later → 601 objects and Redo disabled; ⌘Z → 301 and Redo enabled).
    const afterPaste = (operation: NativeCommandOperation): NativeCommandOperation => ({ state: operation.state, run() {
        const pasting = options.pasteLanding();
        return pasting ? pasting.then(() => operation.run()) : operation.run();
    } });
    const commands: Record<BoardCommand, NativeCommandOperation> = { ...edit, ...arrange, undo: afterPaste(edit.undo), redo: afterPaste(edit.redo),
        copy: clipboard('copy', true), cut: clipboard('cut', true), duplicate: clipboard('duplicate', true),
        paste: op(attached, () => { const active = binding(); if (!active) throw new Error('The board input is not attached'); active.controller.paste(); }),
        copyAsPng: clipboard('copyAsPng'), copyAsSvg: clipboard('copyAsSvg'), copyAsJson: clipboard('copyAsJson'),
        exportPng: clipboard('exportPng'), exportSvg: clipboard('exportSvg'), exportJson: clipboard('exportJson'),
        flatten: options.flatten, editLink: options.editLink, toggleAutoSize: toggleAutoSize(),
        stretchHorizontal: transform('stretch.horizontal', 2), stretchVertical: transform('stretch.vertical', 2),
        rotateClockwise: transform('rotate.clockwise', 1), rotateCounterclockwise: transform('rotate.counterclockwise', 1),
        flipHorizontal: transform('flip.horizontal', 1), flipVertical: transform('flip.vertical', 1),
        convertToBookmark: options.actions.convertToBookmark, convertToEmbed: options.actions.convertToEmbed,
    };
    return createNativeCommandSource({ commands, actions: { ...options.actions, unlockAll: edit.unlockAll }, current: options.current,
        readOnly: () => session.isReadOnly || !options.canWrite(), readOnlyReason: () => session.readOnlyReason ?? 'The document cannot currently be changed',
        unavailableReason: () => 'The board session has ended', label: options.label, shortcut: options.shortcut,
        actionLabel: options.actionLabel, actionShortcut: options.actionShortcut, notice: options.notice, onError: options.onError });
}
