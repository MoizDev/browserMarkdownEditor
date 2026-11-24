import type { PageDisplayItem } from '../../platform/types'
import type { PaintNodeSource, PaintTextItem } from '../render/paintStream'
import { isOutlinePathPiece } from '../text/outlinePieces'
import type { OutlinePiece } from '../text/outlinePieces'
import type { OutlineStreamReply } from '../text/outlineStream'
import { openExportTextStream } from './textStreamLease'

function resolver(source: PaintNodeSource, signal: AbortSignal, chunkPaths: boolean) {
  return async function* resolve(item: PaintTextItem, pageScale: number, requestSignal?: AbortSignal): AsyncGenerator<OutlinePiece> {
    const active = requestSignal && requestSignal !== signal ? AbortSignal.any([signal, requestSignal]) : signal
    const lease = await openExportTextStream(source, item, pageScale, active, chunkPaths)
    let pathOpen = false
    try {
      for (;;) {
        active.throwIfAborted()
        const reply: OutlineStreamReply = await lease.pull(active)
        if (reply.kind !== 'batch' || typeof reply.done !== 'boolean' || !Array.isArray(reply.items) || reply.items.length > 64 || (!reply.done && !reply.items.length))
          throw new TypeError('Invalid text outline stream batch')
        for (const part of reply.items) {
          active.throwIfAborted()
          if (!part) throw new TypeError('Invalid text outline stream item')
          if (part.kind === 'textPathStart') {
            if (!chunkPaths || pathOpen || !Array.isArray(part.fill) || part.fill.length !== 4 || !part.fill.every(Number.isFinite)
              || (part.blend !== 'normal' && part.blend !== 'multiply')) throw new TypeError('Invalid streamed text path start')
            pathOpen = true
          } else if (part.kind === 'textPathChunk') {
            if (!pathOpen || !Array.isArray(part.commands) || part.commands.length > 1024) throw new TypeError('Invalid streamed text path chunk')
          } else if (part.kind === 'textPathEnd') {
            if (!pathOpen) throw new TypeError('Invalid streamed text path end')
            pathOpen = false
          } else if (pathOpen || (part.kind !== 'path' && part.kind !== 'raster')) throw new TypeError('Invalid text outline stream item')
          yield part
        }
        if (reply.done) {
          if (pathOpen) throw new TypeError('Unfinished streamed text path')
          return
        }
      }
    } finally { await lease.release() }
  }
}

/** Pull display items for consumers that require a complete path per text fragment. */
export function createStreamingExportTextResolver(source: PaintNodeSource, signal: AbortSignal) {
  const resolve = resolver(source, signal, false)
  return async function* displayItems(item: PaintTextItem, pageScale: number, requestSignal?: AbortSignal): AsyncGenerator<PageDisplayItem> {
    for await (const piece of resolve(item, pageScale, requestSignal)) {
      if (isOutlinePathPiece(piece)) throw new TypeError('Unexpected chunked text path')
      yield piece
    }
  }
}

/** A sink must preserve start/chunk/end as one path and fill it only once. */
export function createStreamingExportTextPieces(source: PaintNodeSource, signal: AbortSignal) {
  return resolver(source, signal, true)
}
