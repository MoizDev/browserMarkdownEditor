const ID_PREFIX_LENGTH = 8;

const VAULT_ID_SEPARATOR = '~';

export interface AppLocation {
    vault?: string;
    file?: string;
}

function encodePath(path: string): string {
    return path.split('/').map(encodeURIComponent).join('/');
}

function decodePath(path: string): string {
    return path.split('/').map(segment => {
        try {
            return decodeURIComponent(segment);
        } catch {
            return segment;
        }
    }).join('/');
}

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

export function readLocation(): AppLocation {
    return parseLocation(window.location.hash);
}

export function writeLocation(location: AppLocation): void {
    const hash = formatLocation(location);
    const next = `${window.location.pathname}${window.location.search}${hash}`;
    if (next === `${window.location.pathname}${window.location.search}${window.location.hash}`) return;
    try {
        window.history.replaceState(window.history.state, '', next);
    } catch (err) {
        console.warn('Could not update the address bar:', err);
    }
}

export function vaultLinkName(vault: { id: string; name: string }, all: Array<{ id: string; name: string }>): string {
    const shared = all.some(other => other.id !== vault.id
        && other.name.toLowerCase() === vault.name.toLowerCase());
    return shared
        ? `${vault.name}${VAULT_ID_SEPARATOR}${vault.id.slice(0, ID_PREFIX_LENGTH)}`
        : vault.name;
}

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
    return named[0] ?? vaults.find(v => v.name.toLowerCase() === link.toLowerCase());
}
