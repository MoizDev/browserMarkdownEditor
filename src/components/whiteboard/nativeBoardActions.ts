import { surfaceToWorld } from '../../platform/render/camera';
import type { MainAction } from './chrome/mainMenu';
import type { NativeCommandOperation } from './nativeCommandSource';
import type { NativeEditingCapabilities } from './nativeEditingCapabilities';
import type { createNativeCameraOperations } from './nativeCameraOperations';
import type { NativeViewLease } from './nativeViewLease';

export function createNativeBoardActions(options: {
    readonly lease: NativeViewLease;
    readonly capabilities: NativeEditingCapabilities;
    readonly camera: ReturnType<typeof createNativeCameraOperations>;
    readonly shortcutsAvailable: () => boolean;
    readonly openShortcuts: () => void;
    readonly openCommandPalette: () => boolean;
    readonly print: () => boolean;
    readonly exportPdf: () => boolean;
}): Omit<Record<MainAction, NativeCommandOperation>, 'unlockAll'> {
    const { lease, capabilities, camera } = options;
    return { ...camera,
        uploadMedia: {
            state: () => lease.editing?.getImporter() ? { enabled: true } : { enabled: false, reason: 'The board input is not attached' },
            run() {
                const importer = lease.editing?.getImporter();
                if (!importer) throw new Error('The board input is not attached');
                const viewport = lease.camera.viewport;
                importer.open(surfaceToWorld({ x: viewport.width / 2, y: viewport.height / 2 }, lease.camera.camera));
            },
        },
        exportJson: {
            state: () => lease.editing?.getBinding() ? { enabled: true } : { enabled: false, reason: 'The board input is not attached' },
            run() { const binding = lease.editing?.getBinding(); if (!binding) throw new Error('The board input is not attached'); return binding.commands.exportJson('menu'); },
        },
        exportPng: {
            state: () => lease.editing?.getBinding() ? { enabled: true } : { enabled: false, reason: 'The board input is not attached' },
            run() { const binding = lease.editing?.getBinding(); if (!binding) throw new Error('The board input is not attached'); return binding.commands.exportPng('menu'); },
        },
        exportSvg: {
            state: () => lease.editing?.getBinding() ? { enabled: true } : { enabled: false, reason: 'The board input is not attached' },
            run() { const binding = lease.editing?.getBinding(); if (!binding) throw new Error('The board input is not attached'); return binding.commands.exportSvg('menu'); },
        },
        print: {
            state: () => lease.isCurrent() ? { enabled: true } : { enabled: false, reason: 'The board is not open' },
            run() { if (!options.print()) throw new Error('The board is not ready to print'); },
        },
        exportPdf: {
            state: () => lease.isCurrent() ? { enabled: true } : { enabled: false, reason: 'The board is not open' },
            run() { if (!options.exportPdf()) throw new Error('The board is not ready to export'); },
        },
        insertEmbed: capabilities.insertEmbed,
        convertToBookmark: capabilities.convertToBookmark,
        convertToEmbed: capabilities.convertToEmbed,
        keyboardShortcuts: {
            state: () => options.shortcutsAvailable() ? { enabled: true } : { enabled: false, reason: 'Board shortcuts are not attached' },
            run: options.openShortcuts,
        },
        commandPalette: {
            state: () => lease.isCurrent() ? { enabled: true } : { enabled: false, reason: 'The board is not open' },
            run() { if (!options.openCommandPalette()) throw new Error('The command palette is not ready'); },
        },
    };
}
