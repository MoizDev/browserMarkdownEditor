import { useCallback, useEffect, useRef } from 'react';
import type { FileSystemContextValue } from '../types';
import type { DiskVersion } from '../utils/diskVersion';
import { getBaseline, setBaseline } from '../utils/docBaselines';

export interface UsePdfSeedsDeps {
  // useFileSystem()
  readBytesVersioned: FileSystemContextValue['readBytesVersioned'];
}

export function usePdfSeeds(deps: UsePdfSeedsDeps) {
  const { readBytesVersioned } = deps;

  /**
   * A PDF's disk baseline (utils/docBaselines.ts), hashed in the background.
   *
   * PdfPane reads a PDF's bytes itself and the tab buffer never holds them, so
   * opening one cannot wait on a second full read just to hash it (a large PDF
   * is tens of MB). The read is issued at open, while the OS cache is warm, and
   * the first save awaits it if it is still running (flushTab), so a write is
   * never made without one. Keyed by document id; a close drops the pending
   * seed (releaseTab), and a seed that lands after that writes nothing.
   */
  // Each seed resolves to the version it read (null if it failed), so a save
  // whose document closed meanwhile still checks against it (flushTab).
  const pdfSeedsRef = useRef(new Map<string, Promise<DiskVersion | null>>());
  /** Open PDFs whose fingerprint has not been needed yet — see seedPdfBaseline. */
  const pdfSeedSourcesRef = useRef(new Map<string, FileSystemFileHandle>());
  /**
   * Remember HOW to fingerprint an open PDF, without doing it.
   *
   * This used to read the whole file and SHA-256 it the moment a PDF was
   * opened, so that a later write would have a baseline to check the disk
   * against. The pane then read the very same bytes to display them and
   * reported the very same version (`onReaderVersion`), which is what actually
   * set the baseline — the fingerprint was a second full read of a file the
   * reader was already waiting on. Measured on a 10MB document: 19MB read and
   * 19MB hashed before the first page appeared, and it scales straight up with
   * the file. A 100MB scan paid 200MB of it.
   *
   * So nothing is read here. `pdfSeedFor` below starts the read at the one
   * moment the answer is needed — a write, where it is awaited anyway — and
   * skips it entirely when the pane has already supplied the version, which
   * for any PDF that was actually opened is always.
   */
  const seedPdfBaseline = useCallback((id: string, handle: FileSystemFileHandle) => {
    pdfSeedSourcesRef.current.set(id, handle);
  }, []);

  /** The fingerprint a write needs, read now if nobody has supplied one. */
  const pdfSeedFor = useCallback((id: string): Promise<DiskVersion | null> | undefined => {
    if (getBaseline(id)) return undefined;
    const started = pdfSeedsRef.current.get(id);
    if (started) return started;
    const handle = pdfSeedSourcesRef.current.get(id);
    if (!handle) return undefined;
    const seed: Promise<DiskVersion | null> = readBytesVersioned(handle)
      .then(({ version }) => {
        if (pdfSeedsRef.current.get(id) === seed && !getBaseline(id)) setBaseline(id, version);
        return version;
      })
      .catch(err => { console.warn('Could not fingerprint a PDF for outside-change checks:', handle.name, err); return null; })
      .finally(() => { if (pdfSeedsRef.current.get(id) === seed) pdfSeedsRef.current.delete(id); });
    pdfSeedsRef.current.set(id, seed);
    return seed;
  }, [readBytesVersioned]);
  /** Read through a ref to keep the captured IO callback current: the
   *  save helpers keep a stable identity, and a dependency here would re-arm
   *  every timer and listener they own. */
  const pdfSeedForRef = useRef(pdfSeedFor);
  useEffect(() => { pdfSeedForRef.current = pdfSeedFor; }, [pdfSeedFor]);

  return { seedPdfBaseline, pdfSeedForRef, pdfSeedsRef, pdfSeedSourcesRef };
}
