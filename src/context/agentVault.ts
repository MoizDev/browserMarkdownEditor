import { VAULT_AGENT_DIR, VAULT_ID_FILE, parseVaultId, serializeVaultId } from '../utils/vaultAgentStore';

// Both the terminal and the agent must share one serialization: otherwise
// concurrent first use can mint two IDs for the same vault.
let idInFlight: Promise<string | null> = Promise.resolve(null);

export function ensureVaultId(
    root: FileSystemDirectoryHandle,
    writeFile: (handle: FileSystemFileHandle, text: string) => Promise<unknown>,
): Promise<string | null> {
    const next = idInFlight.then(async () => {
        try {
            const dir = await root.getDirectoryHandle(VAULT_AGENT_DIR);
            const existing = parseVaultId(await (await (await dir.getFileHandle(VAULT_ID_FILE)).getFile()).text());
            if (existing) return existing;
        } catch { /* no folder, no file, or unreadable: mint one below */ }
        try {
            const id = crypto.randomUUID();
            const dir = await root.getDirectoryHandle(VAULT_AGENT_DIR, { create: true });
            // createFile truncates and walks a tree this hidden folder is not in.
            await writeFile(await dir.getFileHandle(VAULT_ID_FILE, { create: true }), serializeVaultId(id));
            return id;
        } catch (err) {
            console.error('Could not write the vault id:', err);
            return null;
        }
    });
    idInFlight = next.catch(() => null);
    return next;
}
