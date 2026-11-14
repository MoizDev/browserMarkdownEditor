// Pure display limits; handle identity and the IndexedDB list live in context.
export const MAX_STORED_VAULTS = 30;
export const DEFAULT_RECENT_VAULT_LIMIT = 10;

export function clampRecentVaultLimit(n: number): number {
    if (!Number.isFinite(n)) return DEFAULT_RECENT_VAULT_LIMIT;
    return Math.min(MAX_STORED_VAULTS, Math.max(1, Math.round(n)));
}
