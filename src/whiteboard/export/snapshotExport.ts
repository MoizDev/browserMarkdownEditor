import type { Rect, Rgba } from '../../platform/types'
import { streamRasterPng } from './streamRaster'
import { createExportImageResolver } from './exportImage'
import { streamSvg } from './streamSvg'
import { streamPageDisplayList } from './streamPage'
import type { DisplayPdfWriter } from './capturePdf'
import { snapshotPaintSource, withExportSnapshot } from './snapshot'
import type { PinExportSnapshot } from './snapshot'

export interface SnapshotExportBounds {
  readonly world: Readonly<Rect>
  readonly scale: number
}

/** The host owns the pinned source factory; no live document is read after pinning. */
export function exportSnapshotPng(
  pin: PinExportSnapshot, bounds: SnapshotExportBounds, signal: AbortSignal,
  options: { background?: string; clipboard?: boolean } = {},
): Promise<Blob> {
  return withExportSnapshot(pin, signal, async snapshot => streamRasterPng(
    await snapshotPaintSource(snapshot, signal), snapshot.images, bounds.world, bounds.scale, signal, options))
}

export function exportSnapshotSvg(
  pin: PinExportSnapshot, bounds: SnapshotExportBounds, signal: AbortSignal, background?: Rgba,
): Promise<Blob> {
  return withExportSnapshot(pin, signal, async snapshot => streamSvg(await snapshotPaintSource(snapshot, signal), bounds.world, bounds.scale,
    createExportImageResolver(snapshot.token, snapshot.images, snapshot.readImage, signal), signal, background))
}

/** Vector PDF uses the same pinned source, outline resolver and clipping as notebook pages. */
export function exportSnapshotPdf(
  pin: PinExportSnapshot, bounds: SnapshotExportBounds, writer: DisplayPdfWriter, signal: AbortSignal,
): Promise<Blob> {
  return withExportSnapshot(pin, signal, async snapshot => {
    const source = await snapshotPaintSource(snapshot, signal)
    const images = createExportImageResolver(snapshot.token, snapshot.images, snapshot.readImage, signal)
    const displayList = await streamPageDisplayList(source, 0, bounds.world, bounds.scale, images, signal)
    const bytes = await writer({ schema: 1, pages: [{ width: bounds.world.width * bounds.scale, height: bounds.world.height * bounds.scale,
      displayList: { page: 0, items: [{ kind: 'group', transform: [bounds.scale, 0, 0, bounds.scale, 0, 0], items: displayList.items }] } }] }, { signal })
    signal.throwIfAborted()
    return new Blob([bytes.slice().buffer], { type: 'application/pdf' })
  })
}
