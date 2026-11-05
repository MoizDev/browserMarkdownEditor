// What was half-typed in each chat, kept while the reader is elsewhere: every
// conversation has its own draft, so switching chats carries nothing across,
// coming back restores it, and New chat opens on an empty box (measured
// before: a "half-typed draft" followed the reader into New chat).
//
// In memory only, for the page's life: a draft is a minute's context, not a
// document, and a stored one would outlive the chat it belongs to. A module
// map rather than Composer state so closing and reopening the panel keeps it
// too. Images go with the text; their object URLs belong to the draft until
// it is sent (the message owns them then) or dropped.
//
// The map holds PARKED drafts: the composer parks the chat it leaves
// (putDraft) and reads the one it enters (peekDraft). The entry of the chat
// on screen is stale by definition — it is overwritten when the box leaves it.

import type { PreparedImage } from './chatStore';

export interface Draft {
    text: string;
    images: PreparedImage[];
}

const drafts = new Map<string, Draft>();
/** The live composer; true = it held `key` and emptied itself. */
const discardListeners = new Set<(key: string) => boolean>();

export function peekDraft(key: string): Draft | null {
    return drafts.get(key) ?? null;
}

/** Park what the box holds for `key`; nothing typed and nothing attached
 *  leaves no entry. */
export function putDraft(key: string, text: string, images: PreparedImage[]): void {
    if (!text && images.length === 0) drafts.delete(key);
    else drafts.set(key, { text, images });
}

/** Drop `key`'s draft for good (New chat starts empty), from the map and
 *  from the box if it is the one on screen. */
export function discardDraft(key: string): void {
    let live = false;
    for (const listener of [...discardListeners]) live = listener(key) || live;
    const parked = drafts.get(key);
    drafts.delete(key);
    // A parked draft owns its thumbnails. The box's stale copy may list ones
    // since sent (now the message's): the box freed what was still its own.
    if (parked && !live) for (const img of parked.images) URL.revokeObjectURL(img.url);
}

export function subscribeDiscard(cb: (key: string) => boolean): () => void {
    discardListeners.add(cb);
    return () => { discardListeners.delete(cb); };
}
