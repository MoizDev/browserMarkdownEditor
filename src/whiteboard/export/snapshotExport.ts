import type { Rect, Rgba } from '../../platform/types'
import { streamRasterPng } from './streamRaster'
import { createExportImageResolver } from './exportImage'
import { streamSvg } from './streamSvg'
import { streamPageDisplayList } from './streamPage'
import type { PdfExportWriter } from './capturePdf'
import { streamIncrementalPdf } from './incrementalPdf'
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
  const world = { ...bounds.world }, scale = bounds.scale, frozenOptions = { ...options }
  return withExportSnapshot(pin, signal, async snapshot => streamRasterPng(
    await snapshotPaintSource(snapshot, signal), snapshot.images, world, scale, signal, frozenOptions))
}

export function exportSnapshotSvg(
  pin: PinExportSnapshot, bounds: SnapshotExportBounds, signal: AbortSignal, background?: Rgba,
): Promise<Blob> {
  const world = { ...bounds.world }, scale = bounds.scale
  const color: Rgba | undefined = background ? [background[0], background[1], background[2], background[3]] : undefined
  return withExportSnapshot(pin, signal, async snapshot => streamSvg(await snapshotPaintSource(snapshot, signal), world, scale,
    createExportImageResolver(snapshot.token, snapshot.images, snapshot.readImage, signal), signal, color))
}

/** Vector PDF uses the same pinned source, outline resolver and clipping as notebook pages. */
export function exportSnapshotPdf(
  pin: PinExportSnapshot, bounds: SnapshotExportBounds, writer: PdfExportWriter, signal: AbortSignal,
): Promise<Blob> {
  const world = { ...bounds.world }, scale = bounds.scale
  return withExportSnapshot(pin, signal, async snapshot => {
    const source = await snapshotPaintSource(snapshot, signal, { world, page: 0 })
    const images = createExportImageResolver(snapshot.token, snapshot.images, snapshot.readImage, signal)
    if (typeof writer !== 'function') {
      const bytes = await streamIncrementalPdf({ revision: snapshot.revision, pageCount: 1,
        page: async () => ({ source, world, outputScale: scale }) }, scale, images, writer, signal)
      signal.throwIfAborted()
      return new Blob([bytes.slice().buffer], { type: 'application/pdf' })
    }
    const displayList = await streamPageDisplayList(source, 0, world, scale, images, signal)
    const bytes = await writer({ schema: 1, pages: [{ width: world.width * scale, height: world.height * scale,
      displayList: { page: 0, items: [{ kind: 'group', transform: [scale, 0, 0, scale, 0, 0], items: displayList.items }] } }] }, { signal })
    signal.throwIfAborted()
    return new Blob([bytes.slice().buffer], { type: 'application/pdf' })
  })
}
