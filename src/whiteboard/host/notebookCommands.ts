import type { DisplayPdfWriter } from '../export/capturePdf'
import { exportNotebookPdf } from './notebookExport'
import type { NotebookExportSnapshot } from './notebookExport'

/** Pin one revision synchronously. isCurrent must remain callable after release, so the
 * App can recheck the source owner at the later user-clicked print/write handoff. */
export interface NotebookCommandCapture {
  readonly snapshot: NotebookExportSnapshot
  readonly sourcePath: string
  isCurrent(): boolean
  release(): void
}
export interface NotebookCommandHost {
  capture(): NotebookCommandCapture
  readonly writer: DisplayPdfWriter
  /** App owns target approval, exact backup and versioned write; never truncate first. */
  commit(bytes: Uint8Array, sourcePath: string, isCurrent: () => boolean): Promise<boolean>
  /** Host offers a one-use user-clicked Blob handoff; it must call valid at the click. */
  offerPrint(blob: Blob, valid: () => boolean): void
}
export interface NotebookCommands {
  exportPdf(signal?: AbortSignal): Promise<boolean>
  /** This command is bound to the host's Mod-P only, not the generic print menu. */
  preparePrint(signal?: AbortSignal): Promise<boolean>
  cancel(): void
}

export function createNotebookCommands(host: NotebookCommandHost): NotebookCommands {
  let active: AbortController | undefined
  async function run(print: boolean, signal?: AbortSignal): Promise<boolean> {
    if (active) throw new Error('A notebook export is already running')
    signal?.throwIfAborted()
    const controller = new AbortController()
    active = controller
    const cancel = () => controller.abort(signal?.reason)
    signal?.addEventListener('abort', cancel, { once: true })
    let capture: NotebookCommandCapture | undefined
    try {
      if (signal?.aborted) cancel()
      controller.signal.throwIfAborted()
      capture = host.capture()
      if (!capture.isCurrent()) return false
      const bytes = await exportNotebookPdf(capture.snapshot, capture.sourcePath, host.writer, controller.signal)
      controller.signal.throwIfAborted()
      if (!capture.isCurrent()) return false
      if (print) {
        const pinned = capture
        host.offerPrint(new Blob([Uint8Array.from(bytes)], { type: 'application/pdf' }), () => pinned.isCurrent())
        return true
      }
      return await host.commit(bytes, capture.sourcePath, () => !!capture?.isCurrent() && !controller.signal.aborted)
    } finally {
      signal?.removeEventListener('abort', cancel)
      capture?.release()
      if (active === controller) active = undefined
    }
  }
  return { exportPdf: signal => run(false, signal), preparePrint: signal => run(true, signal), cancel: () => active?.abort() }
}
