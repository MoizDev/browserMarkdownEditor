import { useEffect } from 'react';

/**
 * Object URLs handed to `window.open` for files this app doesn't edit (images,
 * video, archives), one per file VERSION.
 *
 * These were previously minted fresh on every open and never revoked, so a
 * session of browsing media left a permanent registry entry — and a pinned file
 * reference — behind for each click. Reusing the URL bounds that to the number
 * of distinct files opened.
 *
 * Deliberately NOT a timed revoke: the tab we opened may re-request the URL
 * later (a <video> seeking, a reload), and any timeout is a guess about the
 * user's session. Replacing an entry only when the file itself changed is
 * unambiguously safe.
 */
const externalUrls = new Map<string, { url: string; mtime: number; size: number }>();

export function externalOpenUrl(path: string, file: File): string {
  const cached = externalUrls.get(path);
  if (cached && cached.mtime === file.lastModified && cached.size === file.size) return cached.url;
  if (cached) URL.revokeObjectURL(cached.url);
  const url = URL.createObjectURL(file);
  externalUrls.set(path, { url, mtime: file.lastModified, size: file.size });
  return url;
}

/**
 * A different vault can hold the same path, and (mtime, size) alone could
 * match, so drop the URLs with the vault rather than risk serving the old
 * file's bytes (and pinning them all session).
 */
export function useExternalUrlsPerVault(rootHandle: FileSystemDirectoryHandle | null): void {
  useEffect(() => () => {
    for (const { url } of externalUrls.values()) URL.revokeObjectURL(url);
    externalUrls.clear();
  }, [rootHandle]);
}
