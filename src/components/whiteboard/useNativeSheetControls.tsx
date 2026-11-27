import { useCallback, useEffect, useMemo, useSyncExternalStore } from 'react';
import type { BoardRuntime } from '../../whiteboard/host/runtime';
import { createStructureControls, NEW_SHEET_NAME } from '../../whiteboard/host/structureControls';
import type { SheetId } from '../../whiteboard/model/ids';
import type { NativeViewLease } from './nativeViewLease';
import type { BoardQuestion } from './useNativeBoardDialogs';
import { useSheetMenu } from './useSheetMenu';

export function useNativeSheetControls(options: {
    readonly runtime: BoardRuntime;
    readonly lease: NativeViewLease;
    readonly current: () => boolean;
    readonly canWrite: () => boolean;
    readonly readOnly: boolean;
    readonly isVisible: boolean;
    readonly direction: 'ltr' | 'rtl';
    readonly translate: (key: string, values?: Readonly<Record<string, string | number>>) => string;
    readonly confirm: (question: BoardQuestion) => Promise<boolean>;
    readonly onError: (error: unknown) => void;
}) {
    const { runtime, lease, current, canWrite, confirm, onError } = options;
    const controls = useMemo(() => createStructureControls({ runtime, current, canWrite, confirm, onError,
        newSheetName: () => NEW_SHEET_NAME, readPage: () => lease.getNavigationSnapshot().page, jump: page => lease.jump(page) }),
    [runtime, lease, current, canWrite, confirm, onError]);
    const subscribe = useCallback((listener: () => void) => {
        const a = runtime.session.subscribe(listener), b = runtime.selection.subscribe(listener);
        return () => { a(); b(); };
    }, [runtime]);
    const state = useSyncExternalStore(subscribe, controls.snapshot, controls.snapshot);
    const id = (value: string): SheetId | undefined => runtime.session.doc.sheetOrder.find(sheet => sheet.id === value)?.id;
    const sheets = useSheetMenu({ sheets: state.sheets, current: state.current, readOnly: options.readOnly,
        dir: options.direction, t: options.translate,
        select(value) { const sheet = id(value); if (sheet) controls.selectSheet(sheet); },
        create() { controls.createSheet(); },
        rename(value, name) { const sheet = id(value); if (sheet) controls.renameSheet(sheet, name); },
        duplicate(value) { const sheet = id(value); if (sheet) controls.duplicateSheet(sheet); },
        remove(value) { const sheet = id(value); if (sheet) void controls.deleteSheet(sheet); },
        move(value, destination) { const sheet = id(value); if (sheet) controls.moveSheet(sheet, destination); },
    });
    const { closeSheets } = sheets;
    useEffect(() => { if (!options.isVisible) closeSheets(); }, [options.isVisible, closeSheets]);
    return { ...sheets, controls, sheetName: state.sheets.find(sheet => sheet.id === state.current)?.name ?? '' };
}
