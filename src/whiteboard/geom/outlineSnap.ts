import { flattenCubic } from './flatten'
import { realiseFigureContour, type FigureContour } from './figures'
import type { PathOp, Vec2 } from './path'

export interface OutlinePolyline { readonly points: readonly Vec2[]; readonly closed: boolean }
export interface OutlineNearest { readonly point: Vec2; readonly distance: number }

export const OUTLINE_TOLERANCE = 0.25
const MAX_PIECES = 4096

export function contourPolylines(contour: FigureContour): OutlinePolyline[] {
  return pathPolylines(realiseFigureContour(contour, OUTLINE_TOLERANCE, MAX_PIECES))
}

export function pathPolylines(ops: Iterable<PathOp>): OutlinePolyline[] {
  const pieces: { points: Vec2[]; closed: boolean }[] = []
  let current: Vec2[] | null = null
  for (const op of ops) {
    if (op.op === 'M') { current = [op.p]; pieces.push({ points: current, closed: false }); continue }
    if (op.op === 'Z') { if (pieces.length && current) pieces[pieces.length - 1]!.closed = true; current = null; continue }
    if (!current) { current = [op.p]; pieces.push({ points: current, closed: false }); continue }
    if (op.op !== 'C') { current.push(op.p); continue }
    const start = current[current.length - 1]!
    const curve = flattenCubic({ p0: start, p1: op.c1, p2: op.c2, p3: op.p }, OUTLINE_TOLERANCE)
    for (let i = 1; i < curve.length; i++) current.push(curve[i]!)
  }
  return pieces
}

export function rectOutline(rect: { readonly x: number; readonly y: number; readonly width: number; readonly height: number }): OutlinePolyline[] {
  const { x, y, width, height } = rect
  return [{ points: [{ x, y }, { x: x + width, y }, { x: x + width, y: y + height }, { x, y: y + height }], closed: true }]
}

export function transformPolylines(pieces: readonly OutlinePolyline[], pose: { readonly x: number; readonly y: number; readonly rotation: number }): OutlinePolyline[] {
  const c = Math.cos(pose.rotation), s = Math.sin(pose.rotation)
  return pieces.map(piece => ({ closed: piece.closed, points: piece.points.map(p => ({ x: pose.x + c * p.x - s * p.y, y: pose.y + s * p.x + c * p.y })) }))
}

export function nearestOnPolylines(point: Vec2, pieces: readonly OutlinePolyline[]): OutlineNearest | null {
  let best: OutlineNearest | null = null
  for (const piece of pieces) {
    const n = piece.points.length, segments = piece.closed ? n : n - 1
    for (let i = 0; i < segments; i++) {
      const a = piece.points[i]!, b = piece.points[(i + 1) % n]!
      const dx = b.x - a.x, dy = b.y - a.y, length = dx * dx + dy * dy
      const t = length === 0 ? 0 : Math.max(0, Math.min(1, ((point.x - a.x) * dx + (point.y - a.y) * dy) / length))
      const q = { x: a.x + t * dx, y: a.y + t * dy }
      const distance = Math.hypot(point.x - q.x, point.y - q.y)
      if (!best || distance < best.distance) best = { point: q, distance }
    }
  }
  return best
}
