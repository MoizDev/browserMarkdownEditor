import type { SampleBuilderOptions, SampleLease, SampleSequence } from '../ink/samples'
import { SampleBuilder } from '../ink/samples'
import type { NodeId } from '../model/ids'
import type { BoardSession } from '../session/BoardSession'

export interface ContinueInkServices {
  readonly session: BoardSession
  readonly sequence: (ref: number) => SampleSequence
  readonly admit: (builder: SampleBuilder) => SampleLease
  readonly options: Omit<SampleBuilderOptions, 'pressure' | 'precision'>
  // Checks inherited locks, page and active owner; the node must still be the last
  // eligible stroke when the click is committed.
  eligible(id: NodeId): boolean
}

// One immutable replacement preserves the old sample lease for the inverse. The
// caller transforms the clicked world position into this stroke's local space.
export function continueInk(id: NodeId, point: { readonly x: number; readonly y: number }, services: ContinueInkServices): boolean {
  const { session } = services
  const node = session.doc.nodes.get(id)
  if (!node || node.kind !== 'stroke' || node.locked || !services.eligible(id)) return false
  const source = services.sequence(node.samples), last = source.count - 1
  if (last < 0 || !Number.isFinite(point.x) || !Number.isFinite(point.y)) return false
  if (source.x(last) === point.x && source.y(last) === point.y) return false
  const builder = new SampleBuilder({ ...services.options, pressure: node.pressure === 'real', precision: 'float64' })
  for (let i = 0; i < source.count; i++) builder.append(source.x(i), source.y(i), source.pressure(i), i ? source.segmentKind(i - 1) : 'freehand')
  builder.append(point.x, point.y, source.pressure(last), 'straight')
  const lease = services.admit(builder)
  try {
    const current = session.doc.nodes.get(id)
    if (current !== node || !services.eligible(id)) return false
    const applied = session.apply({ origin: 'tool', label: 'Continue stroke', ops: [{ t: 'set', id, key: 'samples', value: lease.ref }] })
    try { return applied.recorded } finally { applied.release() }
  } finally { lease.release() }
}
