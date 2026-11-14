import type { Rect, Rgba } from '../../platform/types'
import { streamRasterPng } from './streamRaster'
import { createExportImageResolver } from './exportImage'
import { streamSvg } from './streamSvg'
import { withExportSnapshot } from './snapshot'
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
  return withExportSnapshot(pin, signal, snapshot => streamRasterPng(
    snapshot.source, snapshot.images, bounds.world, bounds.scale, signal, options))
}

export function exportSnapshotSvg(
  pin: PinExportSnapshot, bounds: SnapshotExportBounds, signal: AbortSignal, background?: Rgba,
): Promise<Blob> {
  return withExportSnapshot(pin, signal, snapshot => streamSvg(snapshot.source, bounds.world, bounds.scale,
    createExportImageResolver(snapshot.token, snapshot.images, snapshot.readImage, signal), signal, background))
}
