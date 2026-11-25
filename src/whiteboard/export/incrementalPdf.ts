import type { PageDisplayItem, PageDisplayList, PathCommand, Rect } from '../../platform/types'
import { InkOutlineJob } from '../ink/outline'
import { inkCoverageChunks, PaintStreamJob } from '../render/paintStream'
import type { PaintInkItem, PaintItem, PaintNodeSource, PaintPathItem, PaintTextItem } from '../render/paintStream'
import { capturePaintClips, paintItemDisplay } from './displayList'
import type { ExportImage } from './displayList'
import { createStreamingExportTextPieces } from './textStreamResolver'
import { yieldToHost } from '../../platform/yieldToHost'
import { paintMayReachPage } from './pageReach'

export type PdfGroupOpen = Omit<Extract<PageDisplayItem, { kind: 'group' }>, 'kind' | 'items'>
export type PdfPathOpen = Omit<Extract<PageDisplayItem, { kind: 'path' }>, 'd'>
export type PdfImageItem = Extract<PageDisplayItem, { kind: 'image' | 'raster' }>

/** Each call consumes its arguments before resolving. Paths and groups stay open across calls. */
export interface IncrementalPdfPage {
  beginGroup(group: PdfGroupOpen, signal: AbortSignal): Promise<void>
  endGroup(signal: AbortSignal): Promise<void>
  beginPath(path: PdfPathOpen, signal: AbortSignal): Promise<void>
  pathCommands(commands: readonly PathCommand[], signal: AbortSignal): Promise<void>
  endPath(signal: AbortSignal): Promise<void>
  image(item: PdfImageItem, signal: AbortSignal): Promise<void>
}

/** No output may be published before finish; cancel discards every unpublished page and path. */
export interface IncrementalPdfSession {
  beginPage(page: { readonly index: number; readonly width: number; readonly height: number }, signal: AbortSignal): Promise<IncrementalPdfPage>
  endPage(page: IncrementalPdfPage, signal: AbortSignal): Promise<void>
  finish(signal: AbortSignal): Promise<Uint8Array>
  cancel(): void | Promise<void>
}
export interface IncrementalPdfWriter {
  readonly kind: 'incremental-pdf'
  open(options: { readonly revision: number; readonly pageCount: number; readonly notebookSource?: { readonly path: string } },
    signal: AbortSignal): Promise<IncrementalPdfSession>
}
export function isIncrementalPdfWriter(value: unknown): value is IncrementalPdfWriter {
  return typeof value === 'object' && value !== null && 'kind' in value && value.kind === 'incremental-pdf'
}
export interface IncrementalPdfPageSource {
  readonly source: PaintNodeSource
  readonly world: Readonly<Rect>
  readonly paper?: PageDisplayList
  /** Additional logical sheets are emitted in order, without collecting a physical page. */
  readonly additionalSources?: AsyncIterable<PaintNodeSource>
  /** Page-space scale; shape realization quality is supplied separately. */
  readonly outputScale?: number
}
export interface IncrementalPdfSource {
  readonly revision: number
  readonly pageCount: number
  page(index: number, signal: AbortSignal): Promise<IncrementalPdfPageSource>
}

const PATH_CHUNK = 1024

function guard(source: PaintNodeSource, signal: AbortSignal): void {
  signal.throwIfAborted()
  if (!source.isCurrent()) throw new Error('PDF paint capture became stale')
}
function validWorld(world: Readonly<Rect>): void {
  if (![world.x, world.y, world.width, world.height].every(Number.isFinite) || world.width <= 0 || world.height <= 0)
    throw new RangeError('Invalid PDF page extent')
}
interface PdfSourceIdentity {
  readonly revision: number
  readonly vaultEpoch: PaintNodeSource['token']['vaultEpoch']
  readonly documentId: PaintNodeSource['token']['documentId']
  readonly bytesGeneration: PaintNodeSource['token']['bytesGeneration']
  readonly session: PaintNodeSource['token']['session']
}
function sourceIdentity(source: PaintNodeSource): PdfSourceIdentity {
  const token = source.token
  return { revision: source.sceneRevision, vaultEpoch: token.vaultEpoch, documentId: token.documentId,
    bytesGeneration: token.bytesGeneration, session: token.session }
}
function sameIdentity(first: PdfSourceIdentity, current: PaintNodeSource): boolean {
  const token = current.token
  return first.revision === current.sceneRevision && first.vaultEpoch === token.vaultEpoch && first.documentId === token.documentId
    && first.bytesGeneration === token.bytesGeneration && first.session === token.session
}
function group(item: Extract<PageDisplayItem, { kind: 'group' }>): PdfGroupOpen {
  return { ...(item.transform ? { transform: item.transform } : {}), ...(item.clip ? { clip: item.clip } : {}),
    ...(item.isolation ? { isolation: item.isolation } : {}) }
}
function pathStyle(item: Extract<PageDisplayItem, { kind: 'path' }>): PdfPathOpen {
  return { kind: 'path', ...(item.fill ? { fill: item.fill } : {}), ...(item.fillRule ? { fillRule: item.fillRule } : {}),
    ...(item.stroke ? { stroke: item.stroke } : {}), ...(item.blend ? { blend: item.blend } : {}) }
}
async function writeCommands(sink: IncrementalPdfPage, commands: readonly PathCommand[], source: PaintNodeSource,
  signal: AbortSignal): Promise<void> {
  for (let at = 0; at < commands.length; at += PATH_CHUNK) {
    guard(source, signal)
    await sink.pathCommands(commands.slice(at, at + PATH_CHUNK), signal)
  }
}
async function writeDisplay(item: PageDisplayItem, sink: IncrementalPdfPage, source: PaintNodeSource,
  signal: AbortSignal, depth = 0): Promise<void> {
  guard(source, signal)
  if (depth > 64) throw new RangeError('PDF group nesting exceeds 64 levels')
  if (item.kind === 'group') {
    await sink.beginGroup(group(item), signal)
    for (const child of item.items) await writeDisplay(child, sink, source, signal, depth + 1)
    guard(source, signal)
    await sink.endGroup(signal)
  } else if (item.kind === 'path') {
    await sink.beginPath(pathStyle(item), signal)
    await writeCommands(sink, item.d, source, signal)
    guard(source, signal)
    await sink.endPath(signal)
  } else await sink.image(item, signal)
  guard(source, signal)
}
async function openPaintGroups(item: PaintItem, sink: IncrementalPdfPage, source: PaintNodeSource,
  signal: AbortSignal): Promise<number> {
  const clips = capturePaintClips(item)
  for (const clip of clips) { guard(source, signal); await sink.beginGroup({ clip }, signal) }
  guard(source, signal)
  await sink.beginGroup({ transform: item.localToWorld }, signal)
  return clips.length + 1
}
async function closeGroups(count: number, sink: IncrementalPdfPage, source: PaintNodeSource, signal: AbortSignal): Promise<void> {
  for (let index = 0; index < count; index++) { guard(source, signal); await sink.endGroup(signal) }
}
function paintPathStyle(item: PaintPathItem): PdfPathOpen {
  return { kind: 'path', fill: item.material.fill, fillRule: item.fillRule, blend: item.material.blend,
    stroke: item.material.stroke && { color: item.material.stroke.color, width: item.material.stroke.width,
      cap: item.material.stroke.cap, join: item.material.stroke.join, miterLimit: item.material.stroke.miterLimit,
      dash: item.material.stroke.dash?.array, dashPhase: item.material.stroke.dash?.phase } }
}
async function writeInk(item: PaintInkItem, scale: number, sink: IncrementalPdfPage, source: PaintNodeSource,
  signal: AbortSignal): Promise<void> {
  const groups = await openPaintGroups(item, sink, source, signal)
  const [a, b, c, d] = item.localToWorld
  const effectiveScale = Math.max(Number.MIN_VALUE, scale * Math.hypot(a, b, c, d))
  await sink.beginPath({ kind: 'path', fill: item.material.color, fillRule: 'nonzero', blend: item.material.blend }, signal)
  for (const coverage of inkCoverageChunks(item.coverage)) {
    let commands: PathCommand[] = []
    const job = new InkOutlineJob(coverage, effectiveScale, command => { commands.push(command) }, Number.MAX_SAFE_INTEGER)
    try {
      for (;;) {
        guard(source, signal)
        const state = job.step(PATH_CHUNK)
        if (commands.length) { const chunk = commands; commands = []; await sink.pathCommands(chunk, signal) }
        if (state === 'complete') break
        if (state === 'cancelled') throw new DOMException('PDF ink capture cancelled', 'AbortError')
        await yieldToHost()
      }
    } catch (error) { job.cancel(); throw error }
  }
  guard(source, signal)
  await sink.endPath(signal)
  await closeGroups(groups, sink, source, signal)
}
async function writeText(item: PaintTextItem, scale: number, sink: IncrementalPdfPage, source: PaintNodeSource,
  signal: AbortSignal, text: ReturnType<typeof createStreamingExportTextPieces>): Promise<void> {
  const groups = await openPaintGroups(item, sink, source, signal)
  let pathOpen = false
  for await (const piece of text(item, scale, signal)) {
    guard(source, signal)
    if (piece.kind === 'textPathStart') {
      if (pathOpen) throw new Error('Nested PDF text path')
      await sink.beginPath({ kind: 'path', fill: piece.fill, blend: piece.blend }, signal)
      pathOpen = true
    } else if (piece.kind === 'textPathChunk') {
      if (!pathOpen) throw new Error('PDF text path chunk without start')
      await sink.pathCommands(piece.commands, signal)
    } else if (piece.kind === 'textPathEnd') {
      if (!pathOpen) throw new Error('PDF text path end without start')
      await sink.endPath(signal)
      pathOpen = false
    } else {
      if (pathOpen) throw new Error('PDF item inside unfinished text path')
      await writeDisplay(piece, sink, source, signal)
    }
  }
  if (pathOpen) throw new Error('Unfinished PDF text path')
  await closeGroups(groups, sink, source, signal)
}
async function writePaint(item: PaintItem, scale: number, image: ExportImage, sink: IncrementalPdfPage,
  source: PaintNodeSource, signal: AbortSignal, text: ReturnType<typeof createStreamingExportTextPieces>): Promise<void> {
  guard(source, signal)
  if (item.kind === 'text') return writeText(item, scale, sink, source, signal, text)
  if (item.kind === 'ink') return writeInk(item, scale, sink, source, signal)
  if (item.kind === 'path') {
    const groups = await openPaintGroups(item, sink, source, signal)
    await sink.beginPath(paintPathStyle(item), signal)
    await writeCommands(sink, item.d, source, signal)
    guard(source, signal)
    await sink.endPath(signal)
    await closeGroups(groups, sink, source, signal)
    return
  }
  await writeDisplay(await paintItemDisplay(item, scale, image, signal), sink, source, signal)
}

/** Stream one pinned physical page without collecting its display list or any whole text/ink path. */
export async function writeIncrementalPdfPage(page: IncrementalPdfPageSource, index: number, scale: number,
  image: ExportImage, sink: IncrementalPdfPage, signal: AbortSignal): Promise<void> {
  const { source, world, paper } = page, outputScale = page.outputScale ?? 1
  if (!Number.isSafeInteger(index) || index < 0 || !Number.isFinite(scale) || scale <= 0
      || !Number.isFinite(outputScale) || outputScale <= 0) throw new RangeError('Invalid PDF page')
  validWorld(world); guard(source, signal)
  if (paper) {
    if (paper.page !== index) throw new RangeError('Paper page does not match output page')
    for (const item of paper.items) await writeDisplay(item, sink, source, signal)
  }
  const clip: PathCommand[] = [['M', world.x, world.y], ['L', world.x + world.width, world.y],
    ['L', world.x + world.width, world.y + world.height], ['L', world.x, world.y + world.height], ['Z']]
  await sink.beginGroup({ transform: [outputScale, 0, 0, outputScale, -world.x * outputScale, -world.y * outputScale], clip: { d: clip } }, signal)
  const identity = sourceIdentity(source)
  const writeSource = async (sheet: PaintNodeSource) => {
    guard(source, signal)
    if (!sameIdentity(identity, sheet)) throw new Error('PDF sheets must share one pinned revision')
    const chunk: PaintItem[] = [], job = new PaintStreamJob(sheet, item => { chunk.push(item) })
    const text = createStreamingExportTextPieces(sheet, signal)
    try {
      let complete = false
      while (!complete) {
        guard(source, signal); guard(sheet, signal)
        const status = job.step(64)
        if (status === 'stale' || status === 'cancelled') throw new Error(`PDF paint capture ${status}`)
        complete = status === 'complete'
        for (const item of chunk) if (await paintMayReachPage(item, world, signal)) await writePaint(item, scale, image, sink, sheet, signal, text)
        chunk.length = 0
        if (!complete) await yieldToHost()
      }
      guard(sheet, signal)
    } finally { job.cancel() }
  }
  await writeSource(source)
  if (page.additionalSources) for await (const sheet of page.additionalSources) await writeSource(sheet)
  guard(source, signal)
  await sink.endGroup(signal)
  guard(source, signal)
}

/** Writer, source and media are already pinned by the owning export job; no partial result escapes. */
export async function streamIncrementalPdf(source: IncrementalPdfSource, scale: number, image: ExportImage,
  writer: IncrementalPdfWriter, signal: AbortSignal, notebookSource?: { readonly path: string }): Promise<Uint8Array> {
  if (!Number.isSafeInteger(source.revision) || source.revision < 0 || !Number.isSafeInteger(source.pageCount) || source.pageCount < 1
      || !Number.isFinite(scale) || scale <= 0) throw new RangeError('Invalid incremental PDF source')
  signal.throwIfAborted()
  const output = await writer.open({ revision: source.revision, pageCount: source.pageCount, ...(notebookSource ? { notebookSource } : {}) }, signal)
  let first: PdfSourceIdentity | undefined
  try {
    for (let index = 0; index < source.pageCount; index++) {
      signal.throwIfAborted()
      const page = await source.page(index, signal), size = page.outputScale ?? 1
      validWorld(page.world)
      if (!Number.isFinite(size) || size <= 0 || page.source.sceneRevision !== source.revision) throw new Error('PDF page revision changed')
      if (first && !sameIdentity(first, page.source)) throw new Error('PDF pages must share one pinned revision')
      first ??= sourceIdentity(page.source)
      guard(page.source, signal)
      const width = page.world.width * size, height = page.world.height * size
      if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) throw new RangeError('Invalid PDF output size')
      const sink = await output.beginPage({ index, width, height }, signal)
      await writeIncrementalPdfPage(page, index, scale, image, sink, signal)
      guard(page.source, signal)
      await output.endPage(sink, signal)
    }
    signal.throwIfAborted()
    const bytes = await output.finish(signal)
    signal.throwIfAborted()
    if (!(bytes instanceof Uint8Array)) throw new TypeError('Invalid incremental PDF output')
    return bytes
  } catch (error) {
    try { await output.cancel() } catch (cleanup) { throw new AggregateError([error, cleanup], 'PDF export and cancellation failed') }
    throw error
  }
}
