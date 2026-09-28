// Which CLI runs the next chat: Claude Code, Codex or OpenCode, each with a
// status dot from the helper's `agents.status`. Picking another agent starts a
// new chat — a chat's session belongs to exactly one CLI.

import { useState } from 'react';
import type { MouseEvent } from 'react';
import { AGENT_IDS, AGENT_LABELS } from '../../../shared/vaultAgentProtocol';
import type { AgentId } from '../../../shared/vaultAgentProtocol';
import type { Theme } from '../../types';
import { Check, ChevronDown } from '../icons';
import { Popover } from './Popover';
import { chatStore, configOf } from './chatStore';
import type { ChatStoreState } from './chatStore';
import { HEALTH_CAPTION, agentHealth } from './useAgentChat';

/** What the header says when the panel is too narrow for the full name
 *  (AgentPanel.css's container query); the tooltip keeps the full one. */
const SHORT_LABELS: Record<AgentId, string> = {
    claude: 'Claude',
    codex: 'Codex',
    opencode: 'OpenCode',
};

export function AgentSelector({ state, theme, disabled }: { state: ChatStoreState; theme: Theme; disabled: boolean }) {
    // The open popover's anchor, in state (not a ref) because it is read
    // during render.
    const [anchor, setAnchor] = useState<HTMLElement | null>(null);
    const open = anchor !== null;
    const current = configOf(state).agent;
    const health = agentHealth(state, current);

    const toggle = (e: MouseEvent<HTMLButtonElement>) => {
        if (open) { setAnchor(null); return; }
        void chatStore.refreshAgents(false);
        setAnchor(e.currentTarget);
    };
    const pick = (agent: AgentId) => {
        setAnchor(null);
        if (agent !== current) chatStore.selectAgent(agent);
    };

    return (
        <>
            <button
                type="button"
                className="agent-selector"
                aria-haspopup="menu"
                aria-expanded={open}
                disabled={disabled}
                onClick={toggle}
                data-tooltip={disabled ? 'Wait for the reply to finish' : `${AGENT_LABELS[current]}: ${HEALTH_CAPTION[health]}`}
            >
                <span className={'agent-dot ' + health} aria-hidden="true" />
                <span className="agent-selector-label">{AGENT_LABELS[current]}</span>
                <span className="agent-selector-label is-short">{SHORT_LABELS[current]}</span>
                <ChevronDown size={12} aria-hidden="true" />
            </button>
            {open && (
                <Popover anchor={anchor} onClose={() => setAnchor(null)} theme={theme} label="Agent" align="end">
                    <div className="agent-popover-title">Agent — a new chat starts on change</div>
                    {AGENT_IDS.map(agent => {
                        const h = agentHealth(state, agent);
                        const status = state.agents.find(a => a.agent === agent);
                        return (
                            <button
                                key={agent}
                                type="button"
                                role="menuitemradio"
                                aria-checked={agent === current}
                                className="agent-popover-row"
                                onClick={() => pick(agent)}
                            >
                                <span className={'agent-dot ' + h} aria-hidden="true" />
                                <span className="agent-popover-row-main">
                                    <span className="agent-popover-row-title">{AGENT_LABELS[agent]}</span>
                                    <span className="agent-popover-row-meta">
                                        {HEALTH_CAPTION[h]}{status?.version ? ` · ${status.version}` : ''}
                                    </span>
                                </span>
                                {agent === current && <Check size={14} className="agent-popover-check" aria-hidden="true" />}
                            </button>
                        );
                    })}
                    <div className="agent-popover-sep" role="separator" />
                    <button type="button" role="menuitem" className="agent-popover-row small" onClick={() => void chatStore.refreshAgents(true)}>
                        Check again
                    </button>
                </Popover>
            )}
        </>
    );
}
