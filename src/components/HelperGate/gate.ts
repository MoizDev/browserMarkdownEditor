// Whether the connection is good enough for a feature, so no gate screen is needed.
// A module of its own: HelperGate.tsx exports only components (fast refresh).

import { helperReady, type BridgeState } from '../../utils/agentBridge';

/** What a feature needs of the helper: the chat, one at or above MIN_HELPER_VERSION;
 *  the terminal, one at or above TERMINAL_VERSION. */
export type GateRequirement = 'chat' | 'terminal';

export function gatePasses(bridge: BridgeState, requirement: GateRequirement): boolean {
    return helperReady(bridge) && (requirement === 'chat' || bridge.helper.terminal);
}
