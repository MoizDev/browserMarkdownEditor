import type { PaintImageItem, PaintPathItem, PaintTextItem } from '../render/paintStream'

export type RasterWireItem = PaintPathItem | PaintImageItem | PaintTextItem
export interface RasterWireImage { readonly key: string; readonly bitmap: ImageBitmap }
