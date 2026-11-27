import React, { useCallback, useMemo, useState } from 'react';
import VaultMenu from './VaultMenu';
import { AgentUpdateDot } from './agentUpdateIndicator';
import { agentUpdateHint, useAgentUpdateNotice } from './agentUpdateHint';
import { ChevronsUpDown, CircleHelp, FileTextOutline, Moon, Network, Settings, Sparkles, SquareTerminal, Sun, Trash2 } from './icons';
import type { FileTreeNode, RecentVault, Theme, VaultOpenResult } from '../types';

const VAULT_MENU_MARGIN = 8;
const VAULT_MENU_MIN_WIDTH = 200;
const VAULT_MENU_MAX_WIDTH = 340;

interface VaultMenuPos { bottom: number; left: number; minWidth: number; maxWidth: number }

function vaultMenuPosFor(button: HTMLElement): VaultMenuPos {
    const r = button.getBoundingClientRect();
    const left = Math.max(VAULT_MENU_MARGIN, Math.round(r.left));
    const room = Math.max(0, Math.round(window.innerWidth - left - VAULT_MENU_MARGIN));
    return {
        bottom: Math.round(window.innerHeight - r.top + 6),
        left,
        minWidth: Math.min(VAULT_MENU_MIN_WIDTH, room),
        maxWidth: Math.min(VAULT_MENU_MAX_WIDTH, room),
    };
}

function countLabel(tree: FileTreeNode[]): string {
    let files = 0;
    let folders = 0;
    const walk = (nodes: FileTreeNode[]) => {
        for (const node of nodes) {
            if (node.kind === 'file') files++;
            else { folders++; walk(node.children); }
        }
    };
    walk(tree);
    return `${files} ${files === 1 ? 'file' : 'files'}, ${folders} ${folders === 1 ? 'folder' : 'folders'}`;
}

interface SidebarFooterProps {
    vaultName: string;
    fileTree: FileTreeNode[];
    recentVaults: RecentVault[];
    currentVaultId: string | null;
    recentVaultLimit: number;
    onOpenRecentVault: (vault: RecentVault) => Promise<VaultOpenResult>;
    onForgetRecentVault: (id: string) => Promise<boolean>;
    onPinRecentVault: (id: string, pinned: boolean) => Promise<boolean>;
    onChangeVault: () => Promise<VaultOpenResult>;
    onRebuildIndex: () => void;
    graphOpen: boolean;
    onToggleGraph: () => void;
    agentOpen: boolean;
    onToggleAgent: () => void;
    terminalOpen: boolean;
    onToggleTerminal: () => void;
    onOpenTrash: () => void;
    onOpenHelp: () => void;
    onOpenSettings: () => void;
    theme: Theme;
    onToggleTheme: () => void;
}

function SidebarFooter({
    vaultName,
    fileTree,
    recentVaults,
    currentVaultId,
    recentVaultLimit,
    onOpenRecentVault,
    onForgetRecentVault,
    onPinRecentVault,
    onChangeVault,
    onRebuildIndex,
    graphOpen,
    onToggleGraph,
    agentOpen,
    onToggleAgent,
    terminalOpen,
    onToggleTerminal,
    onOpenTrash,
    onOpenHelp,
    onOpenSettings,
    theme,
    onToggleTheme,
}: SidebarFooterProps) {
    const [vaultMenu, setVaultMenu] = useState<{ pos: VaultMenuPos; anchor: HTMLElement } | null>(null);

    const listedVaults = useMemo(() => {
        const pinned = recentVaults.filter(v => v.pinned);
        const rest = recentVaults.filter(v => !v.pinned);
        return [...pinned, ...rest.slice(0, Math.max(0, recentVaultLimit - pinned.length))];
    }, [recentVaults, recentVaultLimit]);

    const counts = useMemo(() => countLabel(fileTree), [fileTree]);

    const closeVaultMenu = useCallback(() => setVaultMenu(null), []);

    const handleSwitcherClick = (e: React.MouseEvent<HTMLButtonElement>) => {
        if (e.detail >= 2) {
            setVaultMenu(null);
            onChangeVault();
            return;
        }
        if (vaultMenu) { setVaultMenu(null); return; }
        if (listedVaults.length === 0 && !currentVaultId) { onChangeVault(); return; }
        const switcher = e.currentTarget;
        setVaultMenu({ pos: vaultMenuPosFor(switcher), anchor: switcher });
    };

    const browseForVault = useCallback(() => onChangeVault(), [onChangeVault]);

    const graphLabel = graphOpen ? 'Back to the editor' : 'Neural Brain — graph view';
    const agentNotice = useAgentUpdateNotice();
    const agentUpdate = vaultName ? agentUpdateHint(agentNotice) : null;
    const agentLabel = `${agentOpen ? 'Close the AI agent (⌘⇧X)' : 'AI agent (⌘⇧X)'}${agentUpdate ? ` — ${agentUpdate}` : ''}`;
    const terminalLabel = terminalOpen ? 'Close the terminal (⌃`)' : 'Terminal (⌃`)';
    const themeLabel = theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode';

    return (
        <div className="sidebar-footer">
            <div className="sidebar-footer-tools">
                <button
                    className={`sidebar-footer-btn${graphOpen ? ' is-active' : ''}`}
                    onClick={onToggleGraph}
                    data-tooltip={graphLabel}
                    data-tooltip-position="top"
                    aria-label={graphLabel}
                    aria-pressed={graphOpen}
                >
                    {graphOpen ? <FileTextOutline size={18} strokeWidth={1.75} /> : <Network size={18} strokeWidth={1.75} />}
                </button>
                <button
                    className={`sidebar-footer-btn${agentOpen ? ' is-active' : ''}`}
                    onClick={onToggleAgent}
                    data-tooltip={agentLabel}
                    data-tooltip-position="top"
                    aria-label={agentLabel}
                    aria-pressed={agentOpen}
                    disabled={!vaultName}
                >
                    <Sparkles size={18} strokeWidth={1.75} />
                    {agentUpdate && <AgentUpdateDot />}
                </button>
                <button
                    className={`sidebar-footer-btn${terminalOpen ? ' is-active' : ''}`}
                    onClick={onToggleTerminal}
                    data-tooltip={terminalLabel}
                    data-tooltip-position="top"
                    aria-label={terminalLabel}
                    aria-pressed={terminalOpen}
                    disabled={!vaultName}
                >
                    <SquareTerminal size={18} strokeWidth={1.75} />
                </button>
                <button
                    className="sidebar-footer-btn"
                    onClick={onOpenTrash}
                    data-tooltip="Trash — everything deleted in this vault"
                    data-tooltip-position="top"
                    aria-label="Trash"
                    disabled={!vaultName}
                >
                    <Trash2 size={18} strokeWidth={1.75} />
                </button>
                <button
                    className="sidebar-footer-btn"
                    onClick={onToggleTheme}
                    data-tooltip={themeLabel}
                    data-tooltip-position="top"
                    aria-label={themeLabel}
                >
                    {theme === 'dark' ? <Sun size={18} strokeWidth={1.75} /> : <Moon size={18} strokeWidth={1.75} />}
                </button>
            </div>
            <div className="sidebar-footer-vault">
                <button
                    className={`vault-switcher vault-menu-toggle${vaultMenu ? ' active' : ''}`}
                    onClick={handleSwitcherClick}
                    data-tooltip={`${vaultName}\n\n${counts}`}
                    data-tooltip-position="top"
                    aria-label={`Switch vault — ${vaultName}`}
                    aria-haspopup="menu"
                    aria-expanded={vaultMenu !== null}
                >
                    <ChevronsUpDown size={16} strokeWidth={1.75} className="vault-switcher-chevrons" />
                    <span className="vault-switcher-name">{vaultName}</span>
                </button>
                <button
                    className="sidebar-footer-btn"
                    onClick={onOpenHelp}
                    data-tooltip="Help"
                    data-tooltip-position="top"
                    aria-label="Help"
                >
                    <CircleHelp size={18} strokeWidth={1.75} />
                </button>
                <button
                    className="sidebar-footer-btn"
                    onClick={onOpenSettings}
                    data-tooltip="Settings"
                    data-tooltip-position="top"
                    aria-label="Settings"
                >
                    <Settings size={18} strokeWidth={1.75} />
                </button>
            </div>

            {vaultMenu && (
                <VaultMenu
                    anchor={vaultMenu.anchor}
                    style={vaultMenu.pos}
                    vaults={listedVaults}
                    currentVaultId={currentVaultId}
                    onOpen={onOpenRecentVault}
                    onForget={onForgetRecentVault}
                    onPin={onPinRecentVault}
                    onBrowse={browseForVault}
                    onRebuildIndex={onRebuildIndex}
                    onClose={closeVaultMenu}
                />
            )}
        </div>
    );
}

export default React.memo(SidebarFooter);
