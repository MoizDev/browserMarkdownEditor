import type { RenderToken } from '../../platform/render/types'
import type { PaintNodeSource } from '../render/paintStream'
import type { PaintImageProvider } from '../render/resources'
import type { ReadExportImage } from './exportImage'

/** All members refer to one immutable revision; the lease holds geometry, media and any
 * font resources even if another edit or view detach happens during export. */
export interface ExportSnapshot {
  readonly token: RenderToken
  readonly revision: number
  readonly source: PaintNodeSource
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
    const a = snapshot.token, b = snapshot.source.token
    if (snapshot.revision !== snapshot.source.sceneRevision || a.vaultEpoch !== b.vaultEpoch || a.documentId !== b.documentId
        || a.bytesGeneration !== b.bytesGeneration || a.session !== b.session || !snapshot.source.isCurrent()) {
      throw new Error('Invalid export snapshot identity')
    }
    signal.throwIfAborted()
    const result = await work(snapshot, signal)
    signal.throwIfAborted()
    if (!snapshot.source.isCurrent()) throw new Error('Export snapshot expired')
    return result
  } finally { snapshot.release() }
}
