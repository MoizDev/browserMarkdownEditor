import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Check, Minus } from './icons';
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
    /** Drop a row from the recent list — the folder is not touched. Resolves
     *  false if the list could not be rewritten. */
    onForget: (id: string) => Promise<boolean>;
    /** Fall through to the native folder picker ("Open folder…"). Reports like
     *  `onOpen` — the picker is a vault switch too, so it can come back 'busy'
     *  with no picker ever shown, and this menu is what closes on the result. */
    onBrowse: () => Promise<VaultOpenResult>;
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

/** What 'busy' says. Another raiser's switch — the tree's "Open as Vault", or
 *  the picker — is still walking, so nothing happened; but nothing happening
 *  silently is the dead click messageFor exists to rule out. The row greys and
 *  un-greys inside a walk that runs for seconds, which from the outside is
 *  indistinguishable from a broken button, so say so and leave the menu up. */
const BUSY_NOTE = 'Another vault is still opening — try again in a moment.';

/** The menu's rows, in document order: one per vault, then "Open folder…". */
const rowsIn = (menu: HTMLElement | null): HTMLElement[] =>
    [...(menu?.querySelectorAll<HTMLElement>('.vault-menu-row') ?? [])];

/**
 * Which row focus is sitting in, by position — -1 if it is outside the menu.
 * Answers for a remove control as readily as for the row it belongs to, which
 * is what lets both of them share one keyboard model.
 */
const focusedRowIn = (menu: HTMLElement | null): number =>
    rowsIn(menu).indexOf(document.activeElement?.closest('.vault-menu-row') as HTMLElement);

/**
 * VaultMenu — the small list of recently opened vaults that drops out of the
 * explorer's vault button. Picking one switches the whole app to it; the last
 * row falls through to the native folder picker (as does double-clicking the
 * button itself). Each row also carries a minus that takes it off the list, so
 * the vaults the user actually hops between aren't buried under one-offs.
 *
 * Positioned `fixed` from the anchor's rect, like the linked-mentions popover:
 * the sidebar clips its overflow and can be narrower than this menu.
 */
export default function VaultMenu({ anchor, vaults, currentVaultId, onOpen, onForget, onBrowse, onClose, style }: VaultMenuProps) {
    const [error, setError] = useState<string | null>(null);
    // The vault being opened, if any — a second click while a switch is in
    // flight would race two vaults into the same app.
    const [opening, setOpening] = useState<string | null>(null);
    // Focus is read back out of the DOM rather than from ref arrays: the rows
    // are what shift when one is removed, and the DOM already holds them in
    // order. Parallel arrays would have to be kept aligned with that order by
    // hand, and the row with no minus is exactly what makes them diverge.
    const menuRef = useRef<HTMLDivElement>(null);
    const restoreFocusRef = useRef(true);
    // Where focus should land once a removal has re-rendered the list: the row
    // position, and which of the row's two buttons — the one the removal came
    // from. Landing on the same KIND of button is what keeps the gesture
    // repeatable; a minus click that handed focus to a vault row would arm the
    // next Enter to open a vault nobody chose. Null when nothing is pending.
    const focusRowRef = useRef<{ index: number; control: 'row' | 'forget' } | null>(null);

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
    useEffect(() => { rowsIn(menuRef.current)[0]?.querySelector<HTMLButtonElement>('.vault-menu-item')?.focus(); }, []);

    /** Arrow keys walk the rows only, never the remove controls: putting those
     *  in the ring would double every press needed to reach a vault, taxing the
     *  thing the menu exists for to serve the thing it is tidied with. They are
     *  Tab-reachable in their natural place, and Delete below skips them. */
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
            // Tidying the list means walking it, and walking it is the arrow
            // keys — so the row a keyboard user is already on takes Delete,
            // rather than making every removal a detour through Tab.
            const i = focusedRowIn(menuRef.current);
            const vault = vaults[i];                    // undefined on "Open folder…"
            if (!vault || vault.id === currentVaultId) return;
            e.preventDefault();
            void forget(vault, i, 'row');
        }
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
        else if (result === 'busy') setError(BUSY_NOTE);
        else setError(messageFor(result, vault));
    }, [currentVaultId, opening, onOpen, onClose]);

    /**
     * "Open folder…" — the same shape as `activate`, because the picker is a
     * vault switch on the same gate. Closing the menu here (as FileExplorer
     * used to, before the call) threw away the only surface a 'busy' picker has
     * to report from: the row closed the menu, opened nothing and said nothing.
     * Everything else closes, cancelling the picker included — that is 'ok'.
     */
    const browse = useCallback(async () => {
        if (opening) return;
        setError(null);
        const result = await onBrowse();
        if (result === 'busy') { setError(BUSY_NOTE); return; }
        onClose();
    }, [opening, onBrowse, onClose]);

    /**
     * Take a row off the list. Nothing is destroyed — the vault is a folder that
     * stays exactly where it is, and opening it again puts the row back — so
     * there is no confirmation step in front of this.
     */
    const forget = useCallback(async (vault: RecentVault, index: number, control: 'row' | 'forget') => {
        if (opening) return;
        setError(null);
        // The button holding focus is about to unmount, so name where focus
        // should land; the effect below moves it once the list has re-rendered.
        focusRowRef.current = { index, control };
        if (await onForget(vault.id)) return;
        // The row is still there and still focused; only the promised removal
        // is missing, so say so rather than leave a dead click.
        focusRowRef.current = null;
        setError(`Could not remove “${vault.label}” from this list.`);
    }, [opening, onForget]);

    // Hand focus to whichever row slid into the removed one's place (or, when
    // the last one went, to "Open folder…"). Without this, removing the focused
    // row drops focus to <body> and the arrow keys — which are handled on this
    // menu — stop working.
    useEffect(() => {
        const pending = focusRowRef.current;
        if (!pending) return;
        focusRowRef.current = null;
        // Clamped to 0 because the last row is always "Open folder…" — where
        // focus belongs if the removed row had no successor.
        const row = rowsIn(menuRef.current)[Math.max(0, Math.min(pending.index, vaults.length - 1))];
        // A selector list matches in document order, so 'forget' lands on the
        // minus and falls through to the row button by itself when the
        // successor is the current vault, which has no minus to return to.
        row?.querySelector<HTMLButtonElement>(
            pending.control === 'forget' ? '.vault-menu-forget, .vault-menu-item' : '.vault-menu-item'
        )?.focus();
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
                        {/* No minus on the open vault: every load re-records it,
                            so a remove here would undo itself before the user
                            saw it. The row's grid holds the column empty. */}
                        {!isCurrent && (
                            <button
                                className="vault-menu-forget tree-action-btn"
                                role="menuitem"
                                aria-label={`Remove “${vault.label}” from recent vaults`}
                                title="Remove from this list"
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
                            title={isCurrent ? `${vault.label} (current vault)` : vault.label}
                            onClick={() => activate(vault)}
                        >
                            <span className="vault-menu-label">{vault.label}</span>
                            {isCurrent && <Check size={13} className="vault-menu-check" aria-hidden="true" />}
                        </button>
                    </div>
                );
            })}

            {vaults.length > 0 && <div className="vault-menu-separator" role="separator" />}

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
