import type { PaintImageItem, PaintPathItem } from '../render/paintStream'

/** Ink coverage is converted to its shared nonzero outline before transfer. Text will
 * retain its laid-out payload when the renderer's text item contract is published. */
export type RasterWireItem = PaintPathItem | PaintImageItem
export interface RasterWireImage { readonly key: string; readonly bitmap: ImageBitmap }
