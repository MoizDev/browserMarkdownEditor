export function validNotebookSourcePath(path: unknown): path is string {
    return typeof path === 'string' && !!path && !path.startsWith('/') && !/^[a-z][a-z\d+.-]*:/i.test(path) &&
        !path.includes('\\') && ![...path].some(char => char.charCodeAt(0) < 32) && path.toLowerCase().endsWith('.notebook') &&
        !path.split('/').some(part => !part || part === '.' || part === '..' || ['.Assets', '.Garbage', '.VaultAgent', '.appearance.json'].includes(part));
}
