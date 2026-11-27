export const CONNECTED_ONCE_KEY = 'vaultAgentConnectedOnce';

export type AgentUpdateNotice =
    | { kind: 'available'; version: string }
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
    if (next === notice || (next && notice && next.kind === notice.kind && next.version === notice.version)) return;
    notice = next;
    for (const listener of listeners) listener();
}
