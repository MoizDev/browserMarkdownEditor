// The header's ⋯ menu: which agent runs the next chat, then VaultAgent's own
// housekeeping — "Update VaultAgent to X" when there is one, else "Check for
// updates"; reconnect (with the helper's version at the right); and uninstall
// in red, last.
//
// Which CLI runs the next chat lives HERE rather than in the header: it is
// chosen once and then not thought about, and the panel is 400px wide. Each
// agent's health is its row's description; when the chosen one is not ready
// the composer itself says so and how to fix it. One that is not installed is
// greyed and cannot be chosen, its row saying how to install it: choosing it
// only swapped a working agent for a composer that cannot send.
//
// A row that cannot act stays and says why on hover (`reason`): only a dead row
// gets one (measured: an enabled Uninstall said "Connect to VaultAgent first"
// on hover while connected, when every row carried its reason).

import { useState } from 'react';
import type { MouseEvent, ReactNode } from 'react';
import { AGENT_IDS, AGENT_LABELS, HELPER_NAME } from '../../../shared/vaultAgentProtocol';
import type { AgentId } from '../../../shared/vaultAgentProtocol';
import type { Theme } from '../../types';
import { agentBridge } from '../../utils/agentBridge';
import type { BridgeState } from '../../utils/agentBridge';
import { installerAsset } from '../../utils/platform';
import type { CpuArch, OsKind } from '../../utils/platform';
import { MoreHorizontal, Spark, Terminal } from './ui/icons';
import { IconButton } from './ui/IconButton';
import { MenuRow, MenuSection, MenuSeparator } from './ui/MenuRow';
import { Popover } from './Popover';
import { chatStore, configOf } from './chatStore';
import type { ChatStoreState } from './chatStore';
import { HEALTH_CAPTION, agentHealth } from './useAgentChat';

const WAIT_FOR_UPDATE = 'Wait for the update to finish';

const AGENT_ICON: Record<AgentId, ReactNode> = {
    claude: <Spark />,
    codex: <Terminal />,
    opencode: <Terminal />,
};

export interface MoreMenuProps {
    state: ChatStoreState;
    bridge: BridgeState;
    theme: Theme;
    /** The chat may use the helper (connected, not outdated). */
    ready: boolean;
    /** This browser can reach a helper at all. */
    supported: boolean;
    os: OsKind;
    arch: CpuArch;
    onReconnect: () => void;
    onUpdate: () => void;
    onUninstall: () => void;
}

interface RowSpec {
    title: string;
    run: () => void;
    disabled?: boolean;
    reason?: string;
    /** Run without closing the menu: the row reports in place. */
    stay?: boolean;
    description?: string;
}

/** A "Check for updates" asked for from this menu, while it is open. */
type AskedCheck = 'no' | 'checking' | 'done';

/** The update row, for a helper that can update itself — in place of
 *  "Download installer", which is for one that cannot. null = no such row.
 *
 *  Up to date, it is "Check for updates": a check
 *  that skips the helper's cache, answered in the row itself (the app has no
 *  toast, and a menu that closed on the answer hid it). A newer version turns
 *  it into "Update VaultAgent to X" under the pointer. It was a greyed
 *  "Update VaultAgent", which read as broken rather than as up to date. */
function updateRow(bridge: BridgeState, asked: AskedCheck, onUpdate: () => void, onCheck: () => void): RowSpec | null {
    if (bridge.status === 'updating') return { title: `Updating ${HELPER_NAME}…`, run: () => {}, disabled: true, reason: WAIT_FOR_UPDATE };
    if (bridge.status !== 'connected' || !bridge.helper.selfUpdate) return null;
    const status = bridge.update;
    const check = (description?: string): RowSpec => ({ title: 'Check for updates', run: onCheck, stay: true, description });
    if (asked === 'checking') return check('Checking…');
    switch (status.kind) {
        case 'unsupported': return null;
        case 'available': return { title: `Update ${HELPER_NAME} to ${status.latest}`, run: onUpdate };
        // The last attempt failed: the row tries it again (the strip carries the
        // installer download).
        case 'failed': return { title: status.latest ? `Update ${HELPER_NAME} to ${status.latest}` : `Update ${HELPER_NAME}`, run: onUpdate };
        case 'checking': return check('Checking…');
        case 'unknown': return check(`Couldn't check: ${status.message}`);
        case 'current':
        case 'updated':
            return check(asked === 'done' ? `${HELPER_NAME} ${bridge.helper.version} is the latest version` : undefined);
    }
}

export function MoreMenu({ state, bridge, theme, ready, supported, os, arch, onReconnect, onUpdate, onUninstall }: MoreMenuProps) {
    const [anchor, setAnchor] = useState<HTMLElement | null>(null);
    const [asked, setAsked] = useState<AskedCheck>('no');
    const close = () => setAnchor(null);

    const toggle = (e: MouseEvent<HTMLButtonElement>) => {
        if (anchor) { setAnchor(null); return; }
        setAsked('no');
        // Both cached by the helper, so asking on every open is cheap; the rows
        // are built from what is known now and follow the answers as they land.
        void chatStore.refreshAgents(false);
        void agentBridge.checkForUpdate(false);
        setAnchor(e.currentTarget);
    };

    const connected = bridge.status === 'connected';
    const updating = bridge.status === 'updating';
    const run = state.run;
    const chosen = configOf(state).agent;
    const asset = installerAsset(os, arch);
    const checkNow = () => {
        if (asked === 'checking') return;
        setAsked('checking');
        void agentBridge.checkForUpdate(true).finally(() => setAsked('done'));
    };
    const update = updateRow(bridge, asked, onUpdate, checkNow) ?? {
        title: 'Download installer',
        run: () => { if (asset) window.open(asset.url, '_blank', 'noopener,noreferrer'); },
        disabled: !asset,
        reason: asset ? undefined : `${HELPER_NAME} has no build for this system`,
    };
    // Only what a connected helper said of itself in `hello`: with none (or
    // mid-update, when the one that answered may already be gone) the row
    // shows no version rather than a stale or blank one.
    const version = connected && bridge.helper.version ? bridge.helper.version : null;

    const health = (id: AgentId): string => {
        const status = state.agents.find(a => a.agent === id);
        const caption = HEALTH_CAPTION[agentHealth(state, id)];
        return status?.installed && status.version && agentHealth(state, id) === 'ready' ? `${caption} · ${status.version}` : caption;
    };
    const whyNot = (id: AgentId): string | undefined => {
        if (run) return 'Wait for the reply to finish';
        if (agentHealth(state, id) !== 'missing') return undefined;
        const command = state.agents.find(a => a.agent === id)?.installCommand;
        return command ? `Install it with ${command} in a terminal` : `${AGENT_LABELS[id]} isn't installed`;
    };
    // Said once the row has answered: its description changes under the
    // keyboard, which a screen reader does not re-read.
    const announce = asked === 'done' && update.description ? update.description : '';

    return (
        <>
            <IconButton label={`${HELPER_NAME} menu`} tooltip="More" aria-haspopup="menu" aria-expanded={anchor !== null} onClick={toggle}>
                <MoreHorizontal />
            </IconButton>
            <span className="agent-sr-only" role="status">{announce}</span>
            {anchor && (
                <Popover anchor={anchor} onClose={close} theme={theme} label={`${HELPER_NAME} menu`} align="end" className="agent-more-popover">
                    {ready && (
                        <>
                            <MenuSection label="Agent for new chats" />
                            {AGENT_IDS.map(id => (
                                <MenuRow
                                    key={id}
                                    icon={AGENT_ICON[id]}
                                    title={AGENT_LABELS[id]}
                                    description={health(id)}
                                    checked={id === chosen}
                                    disabled={whyNot(id) !== undefined}
                                    reason={whyNot(id)}
                                    onSelect={() => { close(); if (id !== chosen) chatStore.selectAgent(id); }}
                                />
                            ))}
                            <MenuSeparator />
                        </>
                    )}
                    <MenuRow
                        title={update.title}
                        description={update.description}
                        disabled={update.disabled}
                        reason={update.reason}
                        onSelect={() => { if (!update.stay) close(); update.run(); }}
                    />
                    <MenuRow
                        title="Reconnect"
                        meta={version}
                        disabled={!supported || updating}
                        reason={updating ? WAIT_FOR_UPDATE : !supported ? 'Not available in this browser' : undefined}
                        onSelect={() => { close(); onReconnect(); }}
                    />
                    <MenuSeparator />
                    <MenuRow
                        title={`Uninstall ${HELPER_NAME}…`}
                        danger
                        disabled={!connected}
                        reason={updating ? WAIT_FOR_UPDATE : connected ? undefined : `Connect to ${HELPER_NAME} first`}
                        onSelect={() => { close(); onUninstall(); }}
                    />
                </Popover>
            )}
        </>
    );
}
