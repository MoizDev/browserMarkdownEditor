// React's view onto the two module stores the panel runs on: the connection
// (utils/agentBridge.ts) and the chats (chatStore.ts). Both live outside React
// so a run survives the panel being closed; see each file's header for why.

import { useSyncExternalStore } from 'react';
import { agentBridge } from '../../utils/agentBridge';
import type { BridgeState } from '../../utils/agentBridge';
import { chatStore } from './chatStore';
import type { ChatStoreState } from './chatStore';
import type { AgentId } from '../../../shared/vaultAgentProtocol';

export function useBridgeState(): BridgeState {
    return useSyncExternalStore(agentBridge.subscribeState, agentBridge.getState);
}

export function useChatState(): ChatStoreState {
    return useSyncExternalStore(chatStore.subscribe, chatStore.getState);
}

/** "xhigh" → "Extra high". The CLIs report bare ids. */
export function effortLabel(effort: string): string {
    const known: Record<string, string> = {
        minimal: 'Minimal', low: 'Low', medium: 'Medium', high: 'High',
        xhigh: 'Extra high', max: 'Max', none: 'None',
    };
    return known[effort] ?? effort.charAt(0).toUpperCase() + effort.slice(1);
}

export type AgentHealth = 'ready' | 'logged-out' | 'unknown-login' | 'missing' | 'incompatible' | 'checking';

/** One word for an agent's state — the selector's dot and its caption. */
export function agentHealth(state: ChatStoreState, agent: AgentId): AgentHealth {
    const status = state.agents.find(a => a.agent === agent);
    if (!status) return 'checking';
    if (!status.installed) return 'missing';
    if (status.incompatible) return 'incompatible';
    if (status.loggedIn === false) return 'logged-out';
    if (status.loggedIn === null) return 'unknown-login';
    return 'ready';
}

export const HEALTH_CAPTION: Record<AgentHealth, string> = {
    ready: 'Ready',
    'logged-out': 'Not logged in',
    'unknown-login': 'Login not confirmed',
    missing: 'Not installed',
    incompatible: 'Needs a VaultAgent update',
    checking: 'Checking…',
};
