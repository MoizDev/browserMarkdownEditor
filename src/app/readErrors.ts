/** A read that failed because the file is no longer there — the one failure
 *  that means a saved tab should be dropped rather than kept (see
 *  OpenTab.readError). Same test FileSystemContext uses for a missing vault. */
export function isNotFound(err: unknown): boolean {
  return (err as DOMException)?.name === 'NotFoundError';
}

/** A short, human line for why a read failed — shown in the unreadable pane. */
export function describeReadError(err: unknown): string {
  const message = (err as DOMException)?.message;
  return typeof message === 'string' && message ? message : String(err);
}
