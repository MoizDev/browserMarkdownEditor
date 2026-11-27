import type { SessionEntry } from '../utils/documentSessions';

export const RECOVERY_SESSION_BINDING = Symbol('recovery-session-binding');

export function hasHostedNativeOwner(entry: SessionEntry | undefined, documentId: string): boolean {
  if (!entry || !('peek' in entry.adapter) || typeof entry.adapter.peek !== 'function') return false;
  const hosted: unknown = entry.adapter.peek();
  if (!hosted || typeof hosted !== 'object' || !('owner' in hosted)) return false;
  const owner = hosted.owner;
  return !!owner && typeof owner === 'object' && 'documentId' in owner && 'session' in owner
    && owner.documentId === documentId && owner.session === entry.serial;
}

export function hasWritableHostedNativeOwner(entry: SessionEntry | undefined, documentId: string): boolean {
  if (!hasHostedNativeOwner(entry, documentId) || !entry || !('peek' in entry.adapter) || typeof entry.adapter.peek !== 'function') return false;
  const hosted: unknown = entry.adapter.peek();
  if (!hosted || typeof hosted !== 'object' || !('board' in hosted)) return false;
  const board = hosted.board;
  return !!board && typeof board === 'object' && 'isReadOnly' in board && board.isReadOnly === false;
}
