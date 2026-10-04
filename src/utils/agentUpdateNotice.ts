// "VaultAgent has an update" as a tiny external store, for the parts of the app
// that live OUTSIDE the agent panel (the sidebar's agent button). The main
// chunk imports this, so it imports nothing: the bridge that writes it lives in
// a lazy chunk, and pulling it in here would drag the protocol along.
//
// Written only by utils/agentBridge.ts, from its own state. Deliberately NOT
// tied to the update bar's per-version dismissal: the bar is the loud nudge
// and can be closed; this is the quiet hint that stays until it is true no more.

/** Set by the bridge after the first successful connection; gates every dial
 *  without a click. Here so the main chunk's load-time check can read it without
 *  importing the bridge. */
export const CONNECTED_ONCE_KEY = 'vaultAgentConnectedOnce';

export type AgentUpdateNotice =
    /** A connected helper that can update itself reports a newer release. */
    | { kind: 'available'; version: string }
    /** A connected helper is older than this editor needs (MIN_HELPER_VERSION);
     *  `version` is the helper's own, not a release's. */
    | { kind: 'outdated'; version: string }
    | null;

let notice: AgentUpdateNotice = null;
const listeners = new Set<() => void>();

export function getAgentUpdateNotice(): AgentUpdateNotice {
    return notice;
}

export function subscribeAgentUpdateNotice(listener: () => void): () => void {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
}

export function setAgentUpdateNotice(next: AgentUpdateNotice): void {
    // Compared by value: the bridge re-derives it on every state change, and
    // each notify re-renders the sidebar button.
    if (next === notice || (next && notice && next.kind === notice.kind && next.version === notice.version)) return;
    notice = next;
    for (const listener of listeners) listener();
}
