import type { PaintNodeSource } from '../render/paintStream'
import type { OutlineWorkerReply, OutlineWorkerRequest } from '../text/outlineTypes'
import { boardWorker } from '../workers/client'
import type { BoardJobIdentity } from '../workers/protocol'
import type { ExportText } from './displayList'

/** TX-6 runs only in the export worker. Its returned items are block-local; the shared
 * paint conversion applies the node transform and independently transformed clips once. */
export function createExportTextResolver(source: PaintNodeSource, signal: AbortSignal): ExportText {
  const identity: BoardJobIdentity = { session: crypto.randomUUID(), epoch: source.token.vaultEpoch, revision: source.sceneRevision }
  const current = (candidate: BoardJobIdentity) => !signal.aborted && source.isCurrent()
    && candidate.session === identity.session && candidate.epoch === identity.epoch && candidate.revision === identity.revision
  return async (item, pageScale, requestSignal) => {
    const active = requestSignal && requestSignal !== signal ? AbortSignal.any([signal, requestSignal]) : signal
    active.throwIfAborted()
    const payload: OutlineWorkerRequest = { paint: item.paint, faces: item.faces, localToWorld: item.localToWorld,
      material: item.material, pageScale }
    return boardWorker('export').request<OutlineWorkerReply>('textOutline', payload, identity,
      { priority: 0, signal: active }, current)
  }
}
