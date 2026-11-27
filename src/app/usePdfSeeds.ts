import { useCallback, useEffect, useRef } from 'react';
import type { FileSystemContextValue } from '../types';
import type { DiskVersion } from '../utils/diskVersion';
import { getBaseline, setBaseline } from '../utils/docBaselines';

export interface UsePdfSeedsDeps {
  readBytesVersioned: FileSystemContextValue['readBytesVersioned'];
}

export function usePdfSeeds(deps: UsePdfSeedsDeps) {
  const { readBytesVersioned } = deps;

  const pdfSeedsRef = useRef(new Map<string, Promise<DiskVersion | null>>());
  const pdfSeedSourcesRef = useRef(new Map<string, FileSystemFileHandle>());
  const seedPdfBaseline = useCallback((id: string, handle: FileSystemFileHandle) => {
    pdfSeedSourcesRef.current.set(id, handle);
  }, []);

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
  const pdfSeedForRef = useRef(pdfSeedFor);
  useEffect(() => { pdfSeedForRef.current = pdfSeedFor; }, [pdfSeedFor]);

  return { seedPdfBaseline, pdfSeedForRef, pdfSeedsRef, pdfSeedSourcesRef };
}
