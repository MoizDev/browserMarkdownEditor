import type { Rect } from '../../platform/types'

export type ExportRoute = 'menu' | 'context' | 'copy' | 'print'
export interface ExportScope {
  readonly kind: 'sheet' | 'selection'
  readonly ids: readonly string[]
  readonly bounds: Readonly<Rect>
  /** Only a whole-sheet paged export includes host-owned page backdrops. */
  readonly includeBackdrop: boolean
}
export interface ExportScopeSource {
  readonly selection: readonly string[]
  readonly paged: boolean
  selectionBounds(ids: readonly string[]): Readonly<Rect> | null
  sheetBounds(): Readonly<Rect> | null
}

/** Main-menu file export always uses the whole sheet, even with an active selection. */
export function resolveExportScope(source: ExportScopeSource, route: ExportRoute): ExportScope {
  const selection = route !== 'menu' && source.selection.length > 0
  const ids = selection ? [...source.selection] : []
  const bounds = selection ? source.selectionBounds(ids) : source.sheetBounds()
  if (!bounds || ![bounds.x, bounds.y, bounds.width, bounds.height].every(Number.isFinite)
      || bounds.width <= 0 || bounds.height <= 0) throw new RangeError('Nothing to export')
  return { kind: selection ? 'selection' : 'sheet', ids, bounds: { ...bounds }, includeBackdrop: source.paged && !selection }
}

function safeName(value: string): string {
  return Array.from(value, char => char === '\\' || char === '/' || char.charCodeAt(0) <= 31 || char.charCodeAt(0) === 127 ? ' ' : char).join('').trim() || 'Untitled'
}
function two(value: number): string { return String(value).padStart(2, '0') }
/** The caller supplies time so one command uses one name despite asynchronous rendering. */
export function exportFileName(base: string, sheet: string | null, scope: ExportScope['kind'], extension: 'png' | 'svg', time: Date): string {
  const name = safeName(base)
  if (scope === 'sheet') return `${name}${sheet ? ` – ${safeName(sheet)}` : ''}.${extension}`
  if (!Number.isFinite(time.getTime())) throw new RangeError('Invalid export timestamp')
  const stamp = `${time.getFullYear()}-${two(time.getMonth() + 1)}-${two(time.getDate())} ${two(time.getHours())}.${two(time.getMinutes())}.${two(time.getSeconds())}`
  return `${name} selection ${stamp}.${extension}`
}
