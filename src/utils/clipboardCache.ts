export interface ClipboardCacheEntry {
  readonly encoded: string;
  readonly plain: string;
  readonly cacheOnly: boolean;
  readonly value: object;
  release(): void;
}

export interface ClipboardCache {
  peek(): object | undefined;
  match(encoded: string, plain: string): object | undefined;
  replace(entry: ClipboardCacheEntry): void;
  clear(): void;
  setActive(active: boolean): void;
}

export function createClipboardCache(onError: (error: unknown) => void): ClipboardCache {
  let written: ClipboardCacheEntry | undefined, active = true;
  const release = (entry: ClipboardCacheEntry | undefined) => {
    try { entry?.release(); } catch (error) { onError(error); }
  };
  return {
    peek: () => written?.value,
    match(encoded, plain) {
      return written && written.encoded === encoded && (!written.cacheOnly || written.plain === plain) ? written.value : undefined;
    },
    replace(entry) {
      if (!active) { release(entry); return; }
      const previous = written; written = entry; release(previous);
    },
    clear() { const previous = written; written = undefined; release(previous); },
    setActive(next) { active = next; if (!active) { const previous = written; written = undefined; release(previous); } },
  };
}
