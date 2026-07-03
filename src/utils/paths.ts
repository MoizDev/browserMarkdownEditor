// Vault path helpers. The one convention for how a child's vault-root-relative
// path is formed lives here so every site that must predict it (buildFileTree,
// and the tab handlers on create/move) stays in agreement.

/** Join a parent's vault-relative path with a child name, matching buildFileTree
 *  (root entries have no prefix). */
export function joinVaultPath(parentPath: string, name: string): string {
    return parentPath ? `${parentPath}/${name}` : name;
}
