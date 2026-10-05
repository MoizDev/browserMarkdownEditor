// Where a new terminal should start: the folder of the file the user is in.
//
// A one-function store rather than a prop, for the reason every other store in
// this app exists: the terminal dock is a lazily-mounted chunk that outlives
// individual panes, and threading "which file has focus" through it would
// re-render the dock on every tab switch to answer a question only asked when a
// shell is spawned.
//
// IT STAYS ON THE APP'S SIDE OF THE LINE the terminal is built on — nothing here
// touches the agent, `viewRegistry` or `agentContext`; App fills it from the
// same state the tab bar draws from.
//
// The vault id is the awkward half. The browser knows this file as
// `CS145/sum.rkt` and can never know it as `/Users/…` (the File System Access
// API hands out handles, not paths), so the helper is asked to resolve the
// vault itself — and the only reliable name for "this vault" is the id in
// `.VaultAgent/vault.json`, which may have to be minted first. Hence a promise:
// the first terminal in a brand-new vault waits for that one small write rather
// than opening in the wrong place.

/** What `terminal.open` carries: the vault to resolve, and the folder in it. */
export interface TerminalStart {
    /** From `.VaultAgent/vault.json`; null when there is no vault open (or the
     *  id could not be written), which the helper reads as "start in ~". */
    vaultId: string | null;
    /** Vault-relative, `/`-separated, `''` for the vault root. */
    dir: string;
}

const NOWHERE: TerminalStart = { vaultId: null, dir: '' };

let source: (() => Promise<TerminalStart>) | null = null;

/** App's answer to "where is the user?". Set once, for the app's life. */
export function setTerminalStartSource(fn: () => Promise<TerminalStart>): void {
    source = fn;
}

/** Asked once per shell, at the moment it is spawned — never cached, because
 *  the point is the folder the user is in NOW. */
export async function terminalStart(): Promise<TerminalStart> {
    if (!source) return NOWHERE;
    try {
        return await source();
    } catch {
        // A vault id that could not be read or written is not worth failing a
        // terminal over: it opens in the home directory, as it always did.
        return NOWHERE;
    }
}
