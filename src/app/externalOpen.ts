import { useEffect } from 'react';

const externalUrls = new Map<string, { url: string; mtime: number; size: number }>();

export function externalOpenUrl(path: string, file: File): string {
  const cached = externalUrls.get(path);
  if (cached && cached.mtime === file.lastModified && cached.size === file.size) return cached.url;
  if (cached) URL.revokeObjectURL(cached.url);
  const url = URL.createObjectURL(file);
  externalUrls.set(path, { url, mtime: file.lastModified, size: file.size });
  return url;
}

export function useExternalUrlsPerVault(rootHandle: FileSystemDirectoryHandle | null): void {
  useEffect(() => () => {
    for (const { url } of externalUrls.values()) URL.revokeObjectURL(url);
    externalUrls.clear();
  }, [rootHandle]);
}
