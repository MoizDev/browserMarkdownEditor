import React, { useCallback, useMemo, useState } from 'react';
import VaultMenu from './VaultMenu';
import { ChevronsUpDown, CircleHelp, FileTextOutline, Moon, Network, Settings, Sparkles, Sun, Trash2 } from './icons';
import type { FileTreeNode, RecentVault, Theme, VaultOpenResult } from '../types';

/* The vault menu rises from the switcher, which sits at the very bottom of the
   sidebar — so it is anchored by its BOTTOM edge to the switcher's top, and the
   room it has to grow into sideways is everything from the switcher's left edge
   to the right of the screen. Its width is content-driven (vault names vary);
   left unbounded, a long folder name ran the menu off the window with its
   shorter rows rendering outside it entirely. Computed, not merely capped in
   CSS, for that reason — the same rule ContextMenu's `place` follows. */
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

/** "1 file, 3 folders" — what the switcher's tooltip says under the name. */
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
    /** The open vault's folder name; '' with no vault (Trash is then disabled). */
    vaultName: string;
    /** For the switcher tooltip's counts. The canonical tree already leaves out
     *  .Assets, .Garbage and .appearance.json, so the counts are what the user
     *  sees in the explorer. */
    fileTree: FileTreeNode[];
    /** Folders previously opened as vaults, newest first (already labelled). */
    recentVaults: RecentVault[];
    /** Which of those is open right now, so the menu can mark it. */
    currentVaultId: string | null;
    /** How many of them the menu lists (Settings → Vault). */
    recentVaultLimit: number;
    onOpenRecentVault: (vault: RecentVault) => Promise<VaultOpenResult>;
    /** Drop one vault from the recent list, false if it could not be dropped. */
    onForgetRecentVault: (id: string) => Promise<boolean>;
    /** Open the native folder picker — a double-click on the switcher, or the
     *  menu's "Open folder…" row. Reports the switch's outcome, which that row
     *  needs: the picker shares one gate with every other raiser. */
    onChangeVault: () => Promise<VaultOpenResult>;
    graphOpen: boolean;
    onToggleGraph: () => void;
    /** The AI agent panel docked on the right of the workspace. */
    agentOpen: boolean;
    onToggleAgent: () => void;
    onOpenTrash: () => void;
    onOpenHelp: () => void;
    onOpenSettings: () => void;
    theme: Theme;
    onToggleTheme: () => void;
}

/**
 * The bottom of the sidebar, modelled on Obsidian's: a row of icon buttons
 * (Neural Brain, AI agent, Trash, Theme), and under it the vault switcher with Help and
 * Settings on its right.
 *
 * FIXED AT EVERY SIDEBAR WIDTH (180–600px): nothing wraps or re-flows as the
 * sidebar is dragged, and the vault name is the one elastic thing — it takes
 * what is left and ends in "…". Buttons that jumped between rows as the user
 * resized would never be where the hand expects them.
 *
 * Its own memoized component rather than more of FileExplorer: the vault menu's
 * state lives here, so opening it re-renders these few buttons and not the file
 * tree. Every callback App hands in is stable for the app's life — one inline
 * arrow in App.tsx and this re-renders on every keystroke.
 */
function SidebarFooter({
    vaultName,
    fileTree,
    recentVaults,
    currentVaultId,
    recentVaultLimit,
    onOpenRecentVault,
    onForgetRecentVault,
    onChangeVault,
    graphOpen,
    onToggleGraph,
    agentOpen,
    onToggleAgent,
    onOpenTrash,
    onOpenHelp,
    onOpenSettings,
    theme,
    onToggleTheme,
}: SidebarFooterProps) {
    /** The open vault menu: where it stands, and the switcher it returns
     *  focus to. Null while closed. */
    const [vaultMenu, setVaultMenu] = useState<{ pos: VaultMenuPos; anchor: HTMLElement } | null>(null);

    const listedVaults = useMemo(
        () => recentVaults.slice(0, recentVaultLimit),
        [recentVaults, recentVaultLimit]
    );

    // Per tree refresh, never per keystroke: `fileTree` only changes when the
    // vault's shape does.
    const counts = useMemo(() => countLabel(fileTree), [fileTree]);

    const closeVaultMenu = useCallback(() => setVaultMenu(null), []);

    /**
     * One click lists the vaults already known; two goes to the folder picker.
     *
     * `detail` counts the clicks in the current burst, so the second click of a
     * double-click is caught without delaying the first — waiting out the
     * double-click interval before showing the list would make the ordinary
     * case, picking a vault you already have, feel like the slow one. Keyboard
     * activation reports 0 and lists, which is the only thing it can do.
     */
    const handleSwitcherClick = (e: React.MouseEvent<HTMLButtonElement>) => {
        if (e.detail >= 2) {
            setVaultMenu(null);
            onChangeVault();
            return;
        }
        if (vaultMenu) { setVaultMenu(null); return; }
        // Nothing to list (a first run, or the setting is off) — don't make the
        // user open an empty menu to get to the picker.
        if (listedVaults.length === 0) { onChangeVault(); return; }
        const switcher = e.currentTarget;
        setVaultMenu({ pos: vaultMenuPosFor(switcher), anchor: switcher });
    };

    /** "Open folder…" in the vault menu. The menu is NOT closed here: a picker
     *  refused because another vault switch is still walking comes back 'busy'
     *  with nothing shown, and the menu is the only surface that can say so —
     *  closing first left a row that closed the menu and did nothing at all.
     *  VaultMenu closes itself on every other result. */
    const browseForVault = useCallback(() => onChangeVault(), [onChangeVault]);

    const graphLabel = graphOpen ? 'Back to the editor' : 'Neural Brain — graph view';
    const agentLabel = agentOpen ? 'Close the AI agent (⌘⇧X)' : 'AI agent (⌘⇧X)';
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
                    // The name, a blank line, then the counts — Obsidian's
                    // layout (image 2), minus the folder's full disk path,
                    // which a browser is never told.
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
                    onBrowse={browseForVault}
                    onClose={closeVaultMenu}
                />
            )}
        </div>
    );
}

export default React.memo(SidebarFooter);
