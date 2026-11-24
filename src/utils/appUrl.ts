// The address bar as a bookmark: which vault is open, and what is open in it.
//
//   #vault=Notes&file=Math/HW1.md
//   #vault=Notes~a3f8c2e1&file=Math/HW1.md      ← two known vaults named "Notes"
//
// WHAT THIS CANNOT BE, AND WHY. The obvious design — `?vault=/Users/me/Notes` —
// is impossible, not merely unimplemented. The File System Access API takes no
// path: `showDirectoryPicker` accepts no starting path, and a directory handle
// exposes only its own basename (see the NAMES note in recentVaults.ts). That is
// deliberate on the platform's part, because a page that could name a path and
// be handed a handle for it would be a filesystem read primitive for any site on
// the web. So a link cannot carry a location on disk, and no amount of URL
// design gets around it.
//
// What a link CAN carry is a vault this browser has already been given: the
// handles live in IndexedDB, keyed by id, and a name picks one out of that list.
// So a link works on the machine and browser profile that opened the vault, and
// elsewhere degrades to naming a vault that has to be opened once by hand.
//
// A HASH rather than a query string, for two reasons: it never reaches a server
// (a vault name is a fact about the user's disk), and updating it is free of a
// navigation.

/** A vault id abbreviated to this many characters is short enough to type and
 *  long enough that two of the user's own vaults will not collide. */
const ID_PREFIX_LENGTH = 8;

const VAULT_ID_SEPARATOR = '~';

export interface AppLocation {
    /** A vault's folder name, optionally `name~idprefix` when names collide. */
    vault?: string;
    /** Vault-root-relative path of the open document, in the app's own form. */
    file?: string;
}

/** Percent-encode a path without hiding its slashes — `Math/HW 1.md` should
 *  read as a path in the address bar, not as `Math%2FHW%201.md`. */
function encodePath(path: string): string {
    return path.split('/').map(encodeURIComponent).join('/');
}

function decodePath(path: string): string {
    return path.split('/').map(segment => {
        try {
            return decodeURIComponent(segment);
        } catch {
            // A hand-edited URL can hold a stray '%'. Take the segment as typed
            // rather than throwing away the whole location.
            return segment;
        }
    }).join('/');
}

/** The hash this location writes, including the leading '#'. '' for an empty
 *  location, which clears the hash rather than leaving a bare '#'. */
export function formatLocation(location: AppLocation): string {
    const parts: string[] = [];
    if (location.vault) parts.push(`vault=${encodePath(location.vault)}`);
    if (location.file) parts.push(`file=${encodePath(location.file)}`);
    return parts.length ? `#${parts.join('&')}` : '';
}

export function parseLocation(hash: string): AppLocation {
    const location: AppLocation = {};
    for (const part of hash.replace(/^#/, '').split('&')) {
        const eq = part.indexOf('=');
        if (eq <= 0) continue;
        const key = part.slice(0, eq);
        const value = decodePath(part.slice(eq + 1));
        if (!value) continue;
        if (key === 'vault') location.vault = value;
        else if (key === 'file') location.file = value;
    }
    return location;
}

/** What the address bar says right now. */
export function readLocation(): AppLocation {
    return parseLocation(window.location.hash);
}

/**
 * Point the address bar at `location`.
 *
 * `replaceState`, not `pushState`: this runs on every vault switch and every tab
 * change, and pushing would fill the history with entries whose Back button did
 * nothing — the app does not listen for popstate, so a history entry it cannot
 * honour is worse than no entry at all. Replacing still leaves the address bar
 * correct to copy at any moment, which is the whole point.
 */
export function writeLocation(location: AppLocation): void {
    const hash = formatLocation(location);
    // The URL without any hash at all, so an empty location clears it cleanly.
    const next = `${window.location.pathname}${window.location.search}${hash}`;
    if (next === `${window.location.pathname}${window.location.search}${window.location.hash}`) return;
    try {
        window.history.replaceState(window.history.state, '', next);
    } catch (err) {
        // Never worth breaking a vault switch over: the app is fully usable
        // with a stale address bar.
        console.warn('Could not update the address bar:', err);
    }
}

/** How a vault is named in a link: its folder name, with an id prefix appended
 *  only when another known vault shares that name. */
export function vaultLinkName(vault: { id: string; name: string }, all: Array<{ id: string; name: string }>): string {
    const shared = all.some(other => other.id !== vault.id
        && other.name.toLowerCase() === vault.name.toLowerCase());
    return shared
        ? `${vault.name}${VAULT_ID_SEPARATOR}${vault.id.slice(0, ID_PREFIX_LENGTH)}`
        : vault.name;
}

/**
 * Find the vault a link names.
 *
 * Matching is by NAME, because that is what a person can read and type. The
 * `~idprefix` suffix is the tiebreak, and when a link is ambiguous anyway — two
 * vaults of one name, no suffix — the most recently opened wins rather than the
 * link failing: the list is newest-first, so that is the one the user most
 * likely meant.
 */
export function findLinkedVault<T extends { id: string; name: string }>(
    link: string | undefined,
    vaults: T[],
): T | undefined {
    if (!link) return undefined;
    const separator = link.lastIndexOf(VAULT_ID_SEPARATOR);
    const name = (separator > 0 ? link.slice(0, separator) : link).toLowerCase();
    const idPrefix = separator > 0 ? link.slice(separator + 1).toLowerCase() : '';

    const named = vaults.filter(v => v.name.toLowerCase() === name);
    if (idPrefix) {
        const exact = named.find(v => v.id.toLowerCase().startsWith(idPrefix));
        if (exact) return exact;
    }
    // A whole link that happens to look like "name~suffix" may just be a folder
    // with a tilde in its name; try it verbatim before giving up.
    return named[0] ?? vaults.find(v => v.name.toLowerCase() === link.toLowerCase());
}
