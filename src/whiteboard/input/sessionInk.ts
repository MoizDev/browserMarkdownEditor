import { childrenOf } from '../model/doc'
import { newNodeId, type SheetId } from '../model/ids'
import { createStroke, type StrokeNode } from '../model/nodes'
import { keyBetween } from '../model/orderKey'
import type { SampleLease, SampleRef, SampleSummary } from '../model/samples'
import type { Op } from '../change/ops'
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
  readonly inputPixelWorld: number
  readonly nextSequence: () => number
  readonly rememberStroke: (id: StrokeNode['id']) => void
  readonly admit: (builder: SampleBuilder) => SampleLease
  readonly planStroke?: (node: StrokeNode, summary: SampleSummary | null) => readonly Op[]
  readonly retainWet?: (ref: SampleRef) => SampleLease
  readonly clearRedoAtDown: () => void
  readonly invalidate: () => void
  readonly error: (error: unknown) => void
  readonly mapPoint: (sample: RealSample, out: { x: number; y: number }) => void
  readonly localToWorld: (origin: { readonly x: number; readonly y: number }) => readonly [number, number, number, number, number, number]
}

export function sessionInkContext(first: RealSample, services: SessionInkServices): LiveInkContext {
  const { session, sheet, page, tool, color, width } = services
  const origin = { x: 0, y: 0 }, id = newNodeId(session.doc)
  services.mapPoint(first, origin)
  const pressure = first.source === 'pen' && first.pressureKnown
  const fairTol = 0.25 / (services.declaredMaxScale * 3)
  return {
    identity: { nodeId: id, gestureSequence: services.nextSequence() },
    presentation: { tool, color, width, fairTol, localToWorld: services.localToWorld(origin) },
    builderOptions: { pressure, declaredMaxScale: services.declaredMaxScale },
    captureDeviceScale: services.captureDeviceScale,
    inputPixelWorld: services.inputPixelWorld,
    toLocal: (sample, out) => { services.mapPoint(sample, out); out.x -= origin.x; out.y -= origin.y },
    clearRedoAtDown: services.clearRedoAtDown,
    invalidate: services.invalidate,
    error: services.error,
    commit(builder, identity, undoImmediately, closed) {
      if (!session.doc.sheets.has(sheet)) throw new Error('Ink target sheet no longer exists')
      const siblings = childrenOf(session.doc, sheet)
      const summary = builder.summary()
      const lease = services.admit(builder)
      let wet: SampleLease | undefined
      try {
        const node: StrokeNode = createStroke({ id, parent: sheet, order: keyBetween(siblings.at(-1)?.order ?? null, null), page,
          x: origin.x, y: origin.y, ext: null, tool, samples: lease.ref, pressure: pressure ? 'real' : 'none',
          widthModel: { id: 'uniform' },
          geomVersion: 1, fairTol, closed, width, color })
        if (!undoImmediately) wet = services.retainWet?.(lease.ref)
        const applied = session.apply({ origin: 'tool', label: tool === 'pen' ? 'Draw' : 'Highlight',
          ops: [{ t: 'create', node }, ...(services.planStroke?.(node, summary) ?? [])] })
        let nodeRevision: number
        try {
          if (!applied.recorded) throw new Error('Ink transaction was not recorded')
          nodeRevision = session.doc.rev
          if (undoImmediately) session.history.undo()
          else if (tool === 'pen') services.rememberStroke(id)
        } finally { applied.release() }
        const transferred = wet; wet = undefined
        return { ...identity, nodeRevision, ...(transferred ? { release: () => transferred.release() } : {}) }
      } finally { wet?.release(); lease.release() }
    },
  }
}

export function sessionInkTool(id: 'pen' | 'highlighter', handover: WetInkHandover): Tool<SessionInkServices> {
  return { id, begin: (sample, modifiers, services) => new LiveInk(sample, modifiers, sessionInkContext(sample, services), handover) }
}
