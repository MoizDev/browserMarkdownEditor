import type { BoardCommand, BoardCommandSource, CommandState } from './chrome/boardCommands';
import type { MainAction } from './chrome/mainMenu';

export interface NativeCommandOperation {
    state(): CommandState;
    run(): void | Promise<void>;
}

export interface NativeCommandSourceOptions {
    readonly commands: Record<BoardCommand, NativeCommandOperation>;
    readonly actions: Record<MainAction, NativeCommandOperation>;
    current(): boolean;
    readOnly(): boolean;
    readOnlyReason(): string;
    unavailableReason(): string;
    label(id: BoardCommand): string;
    shortcut(id: BoardCommand): string | undefined;
    actionLabel(id: MainAction): string;
    actionShortcut(id: MainAction): string | undefined;
    notice(message: string): void;
    onError(error: unknown): void;
}

const keyCommands: Readonly<Record<string, BoardCommand>> = {
    delete: 'delete', 'select.all': 'selectAll', group: 'group', ungroup: 'ungroup', lock: 'toggleLocked', duplicate: 'duplicate',
    'arrange.back': 'sendBack', 'arrange.backward': 'sendBackward', 'arrange.forward': 'bringForward', 'arrange.front': 'bringFront',
    'align.left': 'alignLeft', 'align.center': 'alignHorizontal', 'align.right': 'alignRight', 'align.top': 'alignTop',
    'align.middle': 'alignVertical', 'align.bottom': 'alignBottom', 'distribute.horizontal': 'distributeHorizontal',
    'distribute.vertical': 'distributeVertical', flatten: 'flatten',
};

/** The input router and menus consult the same live command authority. */
export function createNativeKeyCommands(source: BoardCommandSource, other: (id: string, event: KeyboardEvent) => boolean) {
    return { run(id: string, event: KeyboardEvent): boolean {
        const command = keyCommands[id];
        if (!command) return other(id, event);
        if (source.state(command).enabled) void source.run(command);
        return true;
    } };
}

const commandMutates: Record<BoardCommand, boolean> = {
    undo: true, redo: true, delete: true, duplicate: true, cut: true, copy: false, paste: true, selectAll: false,
    group: true, ungroup: true, flatten: true, editLink: true, frameSelection: true, toggleLocked: true,
    alignLeft: true, alignHorizontal: true, alignRight: true, alignTop: true, alignVertical: true, alignBottom: true,
    stretchHorizontal: true, stretchVertical: true, distributeHorizontal: true, distributeVertical: true,
    stackHorizontal: true, stackVertical: true, pack: true, sendBack: true, sendBackward: true,
    bringForward: true, bringFront: true, rotateCounterclockwise: true, rotateClockwise: true,
    copyAsPng: false, copyAsSvg: false, copyAsJson: false, exportPng: false, exportSvg: false,
};
const actionMutates: Record<MainAction, boolean> = {
    uploadMedia: true, insertEmbed: true, unlockAll: true, convertToBookmark: true, convertToEmbed: true,
    zoomIn: false, zoomOut: false, zoomToFit: false, zoomToSelection: false, zoomTo100: false,
    toggleMinimap: false, exportPng: false, exportSvg: false, keyboardShortcuts: false,
};

/** One authority for menus and input: eligibility is checked again at invocation. */
export function createNativeCommandSource(options: NativeCommandSourceOptions): BoardCommandSource & {
    actionLabel(id: MainAction): string;
    actionShortcut(id: MainAction): string | undefined;
    actionState(id: MainAction): CommandState;
    runAction(id: MainAction): void | Promise<void>;
} {
    const failed = (error: unknown) => {
        try { options.onError(error); } catch { /* A reporter cannot break command dispatch. */ }
        try { options.notice(error instanceof Error ? error.message : 'The board command failed.'); } catch { /* Preserve the command outcome. */ }
    };
    const state = (operation: NativeCommandOperation, mutates: boolean): CommandState => {
        try {
            const own = operation.state();
            if (!own.enabled) return own;
            if (!options.current()) return { enabled: false, reason: options.unavailableReason() };
            if (mutates && options.readOnly()) return { enabled: false, reason: options.readOnlyReason() };
            return own;
        } catch (error) {
            failed(error);
            return { enabled: false, reason: options.unavailableReason() };
        }
    };
    const invoke = (operation: NativeCommandOperation, mutates: boolean): void | Promise<void> => {
        if (!state(operation, mutates).enabled) return;
        try {
            const result = operation.run();
            if (result) return result.catch(failed);
        } catch (error) { failed(error); }
    };
    return {
        label: id => options.label(id),
        shortcut: id => options.shortcut(id),
        state: id => state(options.commands[id], commandMutates[id]),
        run: id => invoke(options.commands[id], commandMutates[id]),
        actionLabel: id => options.actionLabel(id),
        actionShortcut: id => options.actionShortcut(id),
        actionState: id => state(options.actions[id], actionMutates[id]),
        runAction: id => invoke(options.actions[id], actionMutates[id]),
    };
}
