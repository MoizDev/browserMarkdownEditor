// The agent panel's setup screens. The connection screens themselves are the
// shared HelperGate (the terminal dock shows the same ones); this file is the
// agent's copy for them. An agent that is not ready is said by the composer
// itself (AgentPanel's composerState), not here.
//
// Steps that are known to be done are ticked, so the screen asks only for
// what is still missing: Install once this browser has reached VaultAgent, the login once
// this page has heard an agent report itself logged in. Nothing is asked of
// 127.0.0.1 to find out — only what earlier connections already said.

import { AGENT_IDS, AGENT_LABELS, HELPER_NAME } from '../../../shared/vaultAgentProtocol';
import type { AgentStatus } from '../../../shared/vaultAgentProtocol';
import { hasConnectedBefore } from '../../utils/agentBridge';
import type { BridgeState } from '../../utils/agentBridge';
import { AGENT_LOGIN_HINTS } from '../../utils/platform';
import type { CpuArch, OsKind } from '../../utils/platform';
import { HelperGate } from '../HelperGate/HelperGate';
import { CommandLine } from './CommandLine';

function LoginLines() {
    return (
        <ul className="agent-logins">
            {AGENT_IDS.map(agent => {
                const hint = AGENT_LOGIN_HINTS[agent];
                return (
                    <li key={agent}>
                        <span className="agent-logins-name">{AGENT_LABELS[agent]}</span>
                        <span className="agent-logins-cmd">
                            {hint.commands.map(c => <CommandLine key={c} command={c} />)}
                            {hint.note && <span className="agent-muted">{hint.note}</span>}
                        </span>
                    </li>
                );
            })}
        </ul>
    );
}

const LOGIN_STEP = (
    <li>
        <h3>Log in to your agent in a terminal</h3>
        <LoginLines />
    </li>
);

/** "Claude Code and Codex" — the agents this page last heard were ready. */
function loggedInLine(agents: AgentStatus[]): string | null {
    const names = agents.filter(a => a.installed && a.loggedIn === true).map(a => AGENT_LABELS[a.agent]);
    if (!names.length) return null;
    const list = names.length === 1 ? names[0] : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
    return `${list} ${names.length === 1 ? 'is' : 'are'} logged in.`;
}

export interface SetupGuideProps {
    os: OsKind;
    arch: CpuArch;
    supported: boolean;
    bridge: BridgeState;
    /** What the helper last said about the agents (chatStore), [] = unknown. */
    agents: AgentStatus[];
    onConnect: () => void;
    onUpdate: () => void;
}

export function SetupGuide({ agents, ...props }: SetupGuideProps) {
    const loggedIn = loggedInLine(agents);
    return (
        <HelperGate
            {...props}
            requirement="chat"
            noun="the AI agent"
            title="Set up the AI agent"
            lede={<>
                Chat with Claude Code, Codex or OpenCode about what you're looking at. It runs on this computer
                with your agent's full access, and its edits to this vault land in your editor.
            </>}
            preface={loggedIn ? (
                <li className="is-done">
                    <h3>Log in to your agent in a terminal</h3>
                    <p className="agent-muted">{loggedIn}</p>
                </li>
            ) : LOGIN_STEP}
            done={hasConnectedBefore() ? { installed: `${HELPER_NAME} is set up on this computer.` } : undefined}
        />
    );
}
