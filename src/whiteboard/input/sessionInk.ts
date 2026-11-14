import { childrenOf } from '../model/doc'
import { newNodeId, type SheetId } from '../model/ids'
import { createStroke, type StrokeNode } from '../model/nodes'
import { keyBetween } from '../model/orderKey'
import type { SampleLease } from '../model/samples'
import type { Swatch } from '../model/styles'
import type { SampleBuilder } from '../ink/samples'
import type { BoardSession } from '../session/BoardSession'
import { LiveInk, type LiveInkContext, WetInkHandover } from './liveInk'
import type { RealSample, Tool } from './tool'

export interface SessionInkServices {
  readonly session: BoardSession
  readonly sheet: SheetId
  readonly page: number
  readonly tool: 'pen' | 'highlighter'
  readonly color: Swatch
  readonly width: number
  readonly declaredMaxScale: number
  readonly captureDeviceScale: number
  readonly nextSequence: () => number
  readonly admit: (builder: SampleBuilder) => SampleLease
  readonly clearRedoAtDown: () => void
  readonly invalidate: () => void
  readonly error: (error: unknown) => void
  readonly mapPoint: (sample: RealSample) => { readonly x: number; readonly y: number }
  readonly localToWorld: (origin: { readonly x: number; readonly y: number }) => readonly [number, number, number, number, number, number]
}

// All node content is committed once through the session, while the caller lease
// remains alive until apply and history have retained the newly admitted samples.
export function sessionInkContext(first: RealSample, services: SessionInkServices): LiveInkContext {
  const { session, sheet, page, tool, color, width } = services
  const origin = services.mapPoint(first), id = newNodeId(session.doc)
  const pressure = first.source === 'pen' && first.pressureKnown
  const fairTol = 0.25 / (services.declaredMaxScale * 3)
  return {
    identity: { nodeId: id, gestureSequence: services.nextSequence() },
    presentation: { tool, color, width, fairTol, localToWorld: services.localToWorld(origin) },
    builderOptions: { pressure, declaredMaxScale: services.declaredMaxScale },
    captureDeviceScale: services.captureDeviceScale,
    toLocal: sample => { const point = services.mapPoint(sample); return { x: point.x - origin.x, y: point.y - origin.y } },
    clearRedoAtDown: services.clearRedoAtDown,
    invalidate: services.invalidate,
    error: services.error,
    commit(builder, identity, undoImmediately) {
      if (!session.doc.sheets.has(sheet)) throw new Error('Ink target sheet no longer exists')
      const siblings = childrenOf(session.doc, sheet)
      const lease = services.admit(builder)
      try {
        const node: StrokeNode = createStroke({ id, parent: sheet, order: keyBetween(siblings.at(-1)?.order ?? null, null), page,
          x: origin.x, y: origin.y, ext: null, tool, samples: lease.ref, pressure: pressure ? 'real' : 'none',
          widthModel: { id: 'uniform' },
          geomVersion: 1, fairTol, closed: false, width, color })
        const applied = session.apply({ origin: 'tool', label: tool === 'pen' ? 'Draw' : 'Highlight', ops: [{ t: 'create', node }] })
        try {
          if (!applied.recorded) throw new Error('Ink transaction was not recorded')
          const nodeRevision = session.doc.rev
          if (undoImmediately) session.history.undo()
          return { ...identity, nodeRevision }
        } finally { applied.release() }
      } finally { lease.release() }
    },
  }
}

export function sessionInkTool(id: 'pen' | 'highlighter', handover: WetInkHandover): Tool<SessionInkServices> {
  return { id, begin: (sample, modifiers, services) => new LiveInk(sample, modifiers, sessionInkContext(sample, services), handover) }
}
