// The VaultAgent update hint OUTSIDE the agent panel: a dot on the buttons that
// lead to it, so a newer helper is seen without opening the panel. The panel's
// own bar and ⋯ row say the rest.
//
// Main-chunk code: it reads `utils/agentUpdateNotice` (a tiny store) and reaches
// the bridge only through a dynamic import, at idle, so a session that never
// connected a helper fetches nothing and never dials 127.0.0.1.

import { useSyncExternalStore } from 'react';
import {
    CONNECTED_ONCE_KEY, getAgentUpdateNotice, subscribeAgentUpdateNotice, type AgentUpdateNotice,
} from '../utils/agentUpdateNotice';

export function useAgentUpdateNotice(): AgentUpdateNotice {
    return useSyncExternalStore(subscribeAgentUpdateNotice, getAgentUpdateNotice);
}

/** Appended to a button's tooltip while the dot shows. */
export function agentUpdateHint(notice: AgentUpdateNotice): string | null {
    if (!notice) return null;
    return notice.kind === 'available' ? `VaultAgent ${notice.version} is available` : `VaultAgent ${notice.version} needs an update`;
}

let scheduled = false;

/**
 * Once per page load: ask the helper whether a newer release is out. Only for
 * someone who has connected before — `checkInBackground` then applies the same
 * gate as the panel's auto-connect (Chrome must already allow loopback), so this
 * can never raise the Local Network Access prompt by itself.
 */
export function scheduleAgentUpdateCheck(): void {
    if (scheduled) return; // StrictMode runs the mount effect twice
    scheduled = true;
    try {
        if (localStorage.getItem(CONNECTED_ONCE_KEY) !== '1') return;
    } catch {
        return;
    }
    const run = () => {
        import('../utils/agentBridge').then(m => m.agentBridge.checkInBackground()).catch(() => { /* the panel reports problems; a hint does not */ });
    };
    const idle = (window as unknown as { requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number }).requestIdleCallback;
    if (idle) idle(run, { timeout: 5000 });
    else setTimeout(run, 2000);
}
