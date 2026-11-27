import React, { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { Check, FolderIcon, Minus, Pin } from './icons';
import LucideGlyph from './LucideGlyph';
import { entryColorVar } from '../utils/entryStyle';
import { getEntryStyles, subscribeEntryStyles } from '../utils/entryStyleStore';
import { dismissOnEscape } from '../utils/escapeDismiss';
import type { CSSProperties } from 'react';
import type { RecentVault, VaultOpenResult } from '../types';

interface VaultMenuProps {
    anchor: HTMLElement | null;
    vaults: RecentVault[];
    currentVaultId: string | null;
    onOpen: (vault: RecentVault) => Promise<VaultOpenResult>;
    onForget: (id: string) => Promise<boolean>;
    onPin: (id: string, pinned: boolean) => Promise<boolean>;
    onBrowse: () => Promise<VaultOpenResult>;
    onRebuildIndex: () => void;
    onClose: () => void;
    style?: CSSProperties;
}

function messageFor(result: VaultOpenResult, vault: RecentVault): string {
    switch (result) {
        case 'denied':
            return `Permission to open “${vault.label}” was declined.`;
        case 'missing':
            return `“${vault.label}” is no longer on disk — removed from this list.`;
        default:
            return `Could not open “${vault.label}”.`;
    }
}

const BUSY_NOTE = 'Another vault is still opening — try again in a moment.';

const rowsIn = (menu: HTMLElement | null): HTMLElement[] =>
    [...(menu?.querySelectorAll<HTMLElement>('.vault-menu-row') ?? [])];

const focusedRowIn = (menu: HTMLElement | null): number =>
    rowsIn(menu).indexOf(document.activeElement?.closest('.vault-menu-row') as HTMLElement);

export default function VaultMenu({ anchor, vaults, currentVaultId, onOpen, onForget, onPin, onBrowse, onRebuildIndex, onClose, style }: VaultMenuProps) {
    const [error, setError] = useState<string | null>(null);
    const [opening, setOpening] = useState<string | null>(null);
    const menuRef = useRef<HTMLDivElement>(null);
    const restoreFocusRef = useRef(true);
    const focusRowRef = useRef<{ index: number; control: 'row' | 'forget' } | null>(null);
    const pinFocusRef = useRef<string | null>(null);

    useEffect(() => () => { if (restoreFocusRef.current) anchor?.focus(); }, [anchor]);

    useEffect(() => {
        const onPointerDown = (e: PointerEvent) => {
            const target = e.target as HTMLElement;
            if (target.closest('.vault-menu') || target.closest('.vault-menu-toggle')) return;
            restoreFocusRef.current = false;
            onClose();
        };
        document.addEventListener('pointerdown', onPointerDown, true);
        const stopEscape = dismissOnEscape(onClose);
        window.addEventListener('resize', onClose);
        return () => {
            document.removeEventListener('pointerdown', onPointerDown, true);
            stopEscape();
            window.removeEventListener('resize', onClose);
        };
    }, [onClose]);

    useEffect(() => { rowsIn(menuRef.current)[0]?.querySelector<HTMLButtonElement>('.vault-menu-item')?.focus(); }, []);

    const moveFocus = (delta: number) => {
        const rows = rowsIn(menuRef.current);
        if (!rows.length) return;
        const from = focusedRowIn(menuRef.current);
        const next = from < 0 ? 0 : (from + delta + rows.length) % rows.length;
        rows[next].querySelector<HTMLButtonElement>('.vault-menu-item')?.focus();
    };

    const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
        if (e.key === 'ArrowDown') { e.preventDefault(); moveFocus(1); }
        else if (e.key === 'ArrowUp') { e.preventDefault(); moveFocus(-1); }
        else if (e.key === 'Delete' || e.key === 'Backspace') {
            const i = focusedRowIn(menuRef.current);
            const vault = vaults[i];
            if (!vault || vault.id === currentVaultId) return;
            e.preventDefault();
            void forget(vault, i, 'row');
        }
    };

    const activate = useCallback(async (vault: RecentVault) => {
        if (vault.id === currentVaultId) { onClose(); return; }
        // A switch is already in flight — racing a second one into the same app
        // would leave the tree and the stored handle describing different vaults.
        if (opening) return;
        setError(null);
        setOpening(vault.id);
        const result = await onOpen(vault);
        setOpening(null);
        if (result === 'ok' || result === 'refused') onClose();
        else if (result === 'busy') setError(BUSY_NOTE);
        else setError(messageFor(result, vault));
    }, [currentVaultId, opening, onOpen, onClose]);

    const browse = useCallback(async () => {
        if (opening) return;
        setError(null);
        const result = await onBrowse();
        if (result === 'busy') { setError(BUSY_NOTE); return; }
        onClose();
    }, [opening, onBrowse, onClose]);

    const forget = useCallback(async (vault: RecentVault, index: number, control: 'row' | 'forget') => {
        if (opening) return;
        setError(null);
        focusRowRef.current = { index, control };
        if (await onForget(vault.id)) return;
        focusRowRef.current = null;
        setError(`Could not remove “${vault.label}” from this list.`);
    }, [opening, onForget]);

    const pin = useCallback(async (vault: RecentVault) => {
        if (opening) return;
        setError(null);
        pinFocusRef.current = vault.id;
        if (await onPin(vault.id, !vault.pinned)) return;
        pinFocusRef.current = null;
        setError(`Could not ${vault.pinned ? 'unpin' : 'pin'} “${vault.label}”.`);
    }, [opening, onPin]);

    useEffect(() => {
        const pending = focusRowRef.current;
        if (!pending) return;
        focusRowRef.current = null;
        const row = rowsIn(menuRef.current)[Math.max(0, Math.min(pending.index, vaults.length - 1))];
        row?.querySelector<HTMLButtonElement>(
            pending.control === 'forget' ? '.vault-menu-forget, .vault-menu-item' : '.vault-menu-item'
        )?.focus();
    }, [vaults]);

    useEffect(() => {
        const id = pinFocusRef.current;
        if (!id) return;
        pinFocusRef.current = null;
        menuRef.current
            ?.querySelector<HTMLButtonElement>(`.vault-menu-pin[data-vault="${CSS.escape(id)}"]`)
            ?.focus();
    }, [vaults]);

    return (
        <div
            ref={menuRef}
            className="vault-menu"
            style={style}
            role="menu"
            aria-label="Recent vaults"
            aria-busy={opening !== null}
            onKeyDown={onKeyDown}
        >
            {vaults.map((vault, i) => {
                const isCurrent = vault.id === currentVaultId;
                return (
                    <div className="vault-menu-row" role="none" key={vault.id}>
                        {!isCurrent && (
                            <button
                                className="vault-menu-forget tree-action-btn"
                                role="menuitem"
                                aria-label={`Remove “${vault.label}” from recent vaults`}
                                data-tooltip="Remove from this list"
                                disabled={opening !== null}
                                onClick={() => void forget(vault, i, 'forget')}
                            >
                                <Minus size={13} aria-hidden="true" />
                            </button>
                        )}
                        <button
                            className="vault-menu-item"
                            role="menuitem"
                            aria-current={isCurrent || undefined}
                            data-tooltip={isCurrent ? `${vault.label} (current vault)` : vault.label}
                            onClick={() => activate(vault)}
                        >
                            <VaultRowIcon vault={vault} />
                            <span className="vault-menu-label">{vault.label}</span>
                            {isCurrent && <Check size={13} className="vault-menu-check" aria-hidden="true" />}
                        </button>
                        <button
                            className={`vault-menu-pin tree-action-btn${vault.pinned ? ' is-on' : ''}`}
                            role="menuitem"
                            data-vault={vault.id}
                            aria-label={vault.pinned ? `Unpin “${vault.label}”` : `Pin “${vault.label}” to the top of this list`}
                            aria-pressed={!!vault.pinned}
                            data-tooltip={vault.pinned ? 'Unpin from the top' : 'Keep at the top of this list'}
                            disabled={opening !== null}
                            onClick={() => void pin(vault)}
                        >
                            <Pin size={12} filled={!!vault.pinned} aria-hidden="true" />
                        </button>
                    </div>
                );
            })}

            {vaults.length > 0 && <div className="vault-menu-separator" role="separator" />}

            <div className="vault-menu-row" role="none">
                <button className="vault-menu-item" role="menuitem" onClick={() => { onRebuildIndex(); onClose(); }}>
                    <span className="vault-menu-label">Rebuild index</span>
                </button>
            </div>
            <div className="vault-menu-row" role="none">
                <button
                    className="vault-menu-item"
                    role="menuitem"
                    onClick={() => void browse()}
                >
                    <span className="vault-menu-label">Open folder…</span>
                </button>
            </div>

            {error && <p className="vault-menu-error" role="alert">{error}</p>}
        </div>
    );
}

function VaultRowIcon({ vault }: { vault: RecentVault }) {
    const styles = useSyncExternalStore(subscribeEntryStyles, getEntryStyles);
    const style = vault.vaultPath ? styles.entries[vault.vaultPath] : undefined;
    const nodes = style?.icon ? styles.icons[style.icon] : undefined;
    return (
        <span
            className="vault-menu-icon"
            style={style?.color ? { ['--entry-color' as string]: entryColorVar(style.color) } : undefined}
        >
            {nodes ? <LucideGlyph nodes={nodes} size={13} /> : <FolderIcon size={13} />}
        </span>
    );
}
