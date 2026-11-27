export function joinVaultPath(parentPath: string, name: string): string {
    return parentPath ? `${parentPath}/${name}` : name;
}

export function parentVaultPath(path: string): string {
    const cut = path.lastIndexOf('/');
    return cut === -1 ? '' : path.slice(0, cut);
}
