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

// Characters a portable file name cannot hold become underscores; a name cannot end in a dot or space.
const RESERVED = new Set(['/', '\\', ':', '*', '?', '"', '<', '>', '|'])
function safeName(value: string): string {
  const replaced = Array.from(value, ch => RESERVED.has(ch) || ch.charCodeAt(0) < 32 || ch.charCodeAt(0) === 127 ? '_' : ch).join('')
  return replaced.trim().replace(/[. ]+$/, '') || 'Untitled'
}
const DOCUMENT_EXTENSION = /\.(drawing|tldraw|tldr|notebook|pdf)$/i
function two(value: number): string { return String(value).padStart(2, '0') }
/** The caller supplies time so one command uses one name despite asynchronous rendering. */
/** R-15: the board's own name for a whole-sheet export, and `<name> selection <date time>` for a selection. */
export function exportFileName(base: string, scope: ExportScope['kind'], extension: 'png' | 'svg' | 'pdf' | 'json', time: Date): string {
  // The board is named by its file, whose own extension says what it is, not what the export is: `Board5.tldraw`
  // downloaded as `Board5.tldraw.pdf`. A download, so a taken name is numbered by the browser, not here.
  const name = safeName(base.replace(DOCUMENT_EXTENSION, ''))
  if (scope === 'sheet') return `${name}.${extension}`
  if (!Number.isFinite(time.getTime())) throw new RangeError('Invalid export timestamp')
  const stamp = `${time.getFullYear()}-${two(time.getMonth() + 1)}-${two(time.getDate())} ${two(time.getHours())}.${two(time.getMinutes())}.${two(time.getSeconds())}`
  return `${name} selection ${stamp}.${extension}`
}
