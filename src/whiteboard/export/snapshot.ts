import type { RenderToken } from '../../platform/render/types'
import type { PaintNodeSource } from '../render/paintStream'
import type { PaintImageProvider } from '../render/resources'
import type { ReadExportImage } from './exportImage'

/** All members refer to one immutable revision; the lease holds geometry, media and any
 * font resources even if another edit or view detach happens during export. */
export interface ExportSnapshot {
  readonly token: RenderToken
  readonly revision: number
  /** Resolves only from the pinned SceneSnapshot, never from the live document. */
  paintSource(signal: AbortSignal): Promise<PaintNodeSource>
  readonly images: PaintImageProvider
  readonly readImage: ReadExportImage
  release(): void
}
export type PinExportSnapshot = () => ExportSnapshot

/** Acquire before the first await and release exactly once, on success, failure or abort. */
export async function withExportSnapshot<T>(
  pin: PinExportSnapshot, signal: AbortSignal, work: (snapshot: ExportSnapshot, signal: AbortSignal) => Promise<T>,
): Promise<T> {
  signal.throwIfAborted()
  const snapshot = pin()
  try {
    if (!Number.isSafeInteger(snapshot.revision) || snapshot.revision < 0) throw new Error('Invalid export snapshot revision')
    signal.throwIfAborted()
    const result = await work(snapshot, signal)
    signal.throwIfAborted()
    return result
  } finally { snapshot.release() }
}

/** A source may resolve asynchronously, but it must still name the pinned snapshot. */
export async function snapshotPaintSource(snapshot: ExportSnapshot, signal: AbortSignal): Promise<PaintNodeSource> {
  const source = await snapshot.paintSource(signal)
  signal.throwIfAborted()
  const a = snapshot.token, b = source.token
  if (snapshot.revision !== source.sceneRevision || a.vaultEpoch !== b.vaultEpoch || a.documentId !== b.documentId
      || a.bytesGeneration !== b.bytesGeneration || a.session !== b.session || !source.isCurrent()) {
    throw new Error('Invalid export snapshot identity')
  }
  return source
}
