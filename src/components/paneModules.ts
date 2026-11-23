// The board/notebook and EPUB panes as module slots (moduleSlot.ts): shared by the panes that render them and the idle
// warm-up (prefetchPanes.ts), so a warmed pane renders on its first pass instead of waiting out a Suspense throttle.
import { moduleSlot } from './moduleSlot';

export const canvasPaneSlot = moduleSlot(() => import('./CanvasPane'));
export const nativeCanvasEntrySlot = moduleSlot(() => import('./whiteboard/NativeCanvasEntry'));
export const epubPaneSlot = moduleSlot(() => import('./EpubPane'));
