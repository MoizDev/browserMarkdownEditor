import type { PaintImageItem, PaintPathItem, PaintTextItem } from '../render/paintStream'

/** Ink coverage becomes its shared nonzero outline; laid-out text remains text for fillText. */
export type RasterWireItem = PaintPathItem | PaintImageItem | PaintTextItem
export interface RasterWireImage { readonly key: string; readonly bitmap: ImageBitmap }
