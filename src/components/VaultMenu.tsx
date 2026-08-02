import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Check } from './icons';
import type { CSSProperties } from 'react';
import type { RecentVault, VaultOpenResult } from '../types';

interface VaultMenuProps {
    /** The button this menu hangs off — focus returns to it when it closes. */
    anchor: HTMLElement | null;
    /** Recently opened vaults, newest first, already trimmed to the user's limit. */
    vaults: RecentVault[];
    /** The one that is open right now — marked, and inert to click. */
    currentVaultId: string | null;
    onOpen: (vault: RecentVault) => Promise<VaultOpenResult>;
    /** Fall through to the native folder picker ("Open folder…"). */
    onBrowse: () => void;
    onClose: () => void;
    /** Fixed positioning under the anchor button, from its bounding rect. */
    style?: CSSProperties;
}

/** What to say when a row didn't open. Never silence: from the outside a dead
 *  click is indistinguishable from a broken button. */
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

/**
 * VaultMenu — the small list of recently opened vaults that drops out of the
 * explorer's vault button. Picking one switches the whole app to it; the last
 * row falls through to the native folder picker (as does double-clicking the
 * button itself).
 *
 * Positioned `fixed` from the anchor's rect, like the linked-mentions popover:
 * the sidebar clips its overflow and can be narrower than this menu.
 */
export default function VaultMenu({ anchor, vaults, currentVaultId, onOpen, onBrowse, onClose, style }: VaultMenuProps) {
    const [error, setError] = useState<string | null>(null);
    // The vault being opened, if any — a second click while a switch is in
    // flight would race two vaults into the same app.
    const [opening, setOpening] = useState<string | null>(null);
    const itemsRef = useRef<(HTMLButtonElement | null)[]>([]);
    const restoreFocusRef = useRef(true);

    // Focus goes back to the button on the way out — the menu takes it on open
    // (below), so Escape or a pick would otherwise strand a keyboard user at the
    // top of the document. Not when a click elsewhere dismissed the menu: that
    // click is already choosing where focus goes.
    useEffect(() => () => { if (restoreFocusRef.current) anchor?.focus(); }, [anchor]);

    // Dismiss on outside-click, Escape, or window resize (which invalidates the
    // anchor rect this menu was positioned from). Mirrors the backlinks popover
    // — the anchor button is excluded so its own click can toggle the menu shut
    // instead of being closed here and immediately reopened.
    useEffect(() => {
        const onPointerDown = (e: PointerEvent) => {
            const target = e.target as HTMLElement;
            if (target.closest('.vault-menu') || target.closest('.vault-menu-toggle')) return;
            restoreFocusRef.current = false;
            onClose();
        };
        const onKeyDown = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
        document.addEventListener('pointerdown', onPointerDown, true);
        document.addEventListener('keydown', onKeyDown);
        window.addEventListener('resize', onClose);
        return () => {
            document.removeEventListener('pointerdown', onPointerDown, true);
            document.removeEventListener('keydown', onKeyDown);
            window.removeEventListener('resize', onClose);
        };
    }, [onClose]);

    // Focus the first row so the menu is operable from the keyboard the moment
    // it opens. Programmatic focus after a click doesn't match :focus-visible,
    // so a mouse user sees no ring.
    useEffect(() => { itemsRef.current[0]?.focus(); }, []);

    const moveFocus = (delta: number) => {
        const items = itemsRef.current.filter((el): el is HTMLButtonElement => !!el);
        if (!items.length) return;
        const from = items.indexOf(document.activeElement as HTMLButtonElement);
        const next = from < 0 ? 0 : (from + delta + items.length) % items.length;
        items[next].focus();
    };

    const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
        if (e.key === 'ArrowDown') { e.preventDefault(); moveFocus(1); }
        else if (e.key === 'ArrowUp') { e.preventDefault(); moveFocus(-1); }
    };

    const activate = useCallback(async (vault: RecentVault) => {
        // Already here: the row is a marker, not a command.
        if (vault.id === currentVaultId) { onClose(); return; }
        // A switch is already in flight — racing a second one into the same app
        // would leave the tree and the stored handle describing different vaults.
        if (opening) return;
        setError(null);
        setOpening(vault.id);
        const result = await onOpen(vault);
        setOpening(null);
        if (result === 'ok') onClose();
        else setError(messageFor(result, vault));
    }, [currentVaultId, opening, onOpen, onClose]);

    return (
        <div
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
                    <button
                        key={vault.id}
                        ref={el => { itemsRef.current[i] = el; }}
                        className="vault-menu-item"
                        role="menuitem"
                        aria-current={isCurrent || undefined}
                        title={isCurrent ? `${vault.label} (current vault)` : vault.label}
                        onClick={() => activate(vault)}
                    >
                        <span className="vault-menu-label">{vault.label}</span>
                        {isCurrent && <Check size={13} className="vault-menu-check" aria-hidden="true" />}
                    </button>
                );
            })}

            <div className="vault-menu-separator" role="separator" />

            <button
                ref={el => { itemsRef.current[vaults.length] = el; }}
                className="vault-menu-item"
                role="menuitem"
                onClick={onBrowse}
            >
                <span className="vault-menu-label">Open folder…</span>
            </button>

            {error && <p className="vault-menu-error" role="alert">{error}</p>}
        </div>
    );
}
