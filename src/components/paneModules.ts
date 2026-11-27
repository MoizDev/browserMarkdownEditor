import { moduleSlot } from './moduleSlot';

export const canvasPaneSlot = moduleSlot(() => import('./CanvasPane'));
export const nativeCanvasEntrySlot = moduleSlot(() => import('./whiteboard/NativeCanvasEntry'));
export const epubPaneSlot = moduleSlot(() => import('./EpubPane'));
