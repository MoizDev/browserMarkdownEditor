export const DRAWING_EXT = '.tldraw';
export const NATIVE_DRAWING_EXT = '.drawing';

export const NOTEBOOK_EXT = '.notebook';

export function isDrawingFile(name: string): boolean {
    const lower = name.toLowerCase();
    return lower.endsWith(DRAWING_EXT) || lower.endsWith('.tldr');
}

export function isNativeDrawingFile(name: string): boolean {
    return name.toLowerCase().endsWith(NATIVE_DRAWING_EXT);
}

export function isNotebookFile(name: string): boolean {
    return name.toLowerCase().endsWith(NOTEBOOK_EXT);
}

export function isCanvasFile(name: string): boolean {
    return isDrawingFile(name) || isNativeDrawingFile(name) || isNotebookFile(name);
}

export function ensureNotebookExt(name: string): string {
    return isNotebookFile(name) ? name : `${name}${NOTEBOOK_EXT}`;
}

export const MD_EXT = '.md';

export function isMarkdownFile(name: string): boolean {
    return name.toLowerCase().endsWith(MD_EXT);
}

const CODE_EXTENSIONS = new Set([
    'rkt', 'racket', 'rktl', 'rktd', 'scrbl', 'scm', 'ss', 'lisp', 'el', 'clj', 'cljs', 'cljc', 'edn',
    'c', 'h', 'cc', 'cpp', 'cxx', 'hpp', 'hh', 'hxx', 'ipp', 'm', 'mm', 'cs',
    'py', 'pyw', 'pyi', 'rb', 'pl', 'pm', 'lua', 'r', 'jl', 'php',
    'js', 'jsx', 'mjs', 'cjs', 'ts', 'tsx', 'mts', 'cts', 'vue', 'svelte',
    'go', 'rs', 'java', 'kt', 'kts', 'swift', 'scala', 'dart', 'ex', 'exs', 'erl',
    'hs', 'ml', 'mli', 'fs', 'fsx', 'nim', 'zig', 'v', 'sv', 'vhd', 'asm', 's',
    'sh', 'bash', 'zsh', 'fish', 'ps1', 'bat', 'cmd', 'vim',
    'sql', 'graphql', 'gql', 'proto', 'tf', 'hcl', 'gradle', 'groovy', 'cmake', 'mk',
    'html', 'htm', 'css', 'scss', 'sass', 'less', 'xml', 'svg', 'json', 'jsonc',
    'yaml', 'yml', 'toml', 'ini', 'cfg', 'conf', 'env', 'diff', 'patch',
]);

const CODE_NAMES = new Set([
    'makefile', 'dockerfile', 'containerfile', 'rakefile', 'gemfile', 'brewfile',
    'justfile', 'procfile', 'cmakelists.txt', '.gitignore', '.gitattributes',
    '.editorconfig', '.env', '.npmrc', '.prettierrc', '.eslintrc',
]);

export function isCodeFile(name: string): boolean {
    const lower = name.toLowerCase();
    if (CODE_NAMES.has(lower)) return true;
    const dot = lower.lastIndexOf('.');
    return dot > 0 && CODE_EXTENSIONS.has(lower.slice(dot + 1));
}

export function isTexFile(name: string): boolean {
    return name.toLowerCase().endsWith('.tex');
}

export function noteDisplayName(name: string): string {
    return name.replace(/\.md$/i, '') || name;
}

export function isImageFile(name: string): boolean {
    return /\.(png|jpe?g|gif|webp|bmp|avif|svg)$/i.test(name);
}

export const PDF_EXT = '.pdf';

export function isPdfFile(name: string): boolean {
    return name.toLowerCase().endsWith(PDF_EXT);
}

function stripExt(name: string): string {
    return name.slice(0, -PDF_EXT.length);
}

export function stripPdfExt(name: string): string {
    return isPdfFile(name) ? stripExt(name) : name;
}

export function notebookPdfName(name: string): string {
    return `${isNotebookFile(name) ? name.slice(0, -NOTEBOOK_EXT.length) : name}${PDF_EXT}`;
}



/** Native binary, always read-only. Keep separate from vault text eligibility. */
export function isEpubFile(name: string): boolean { return /\.epub$/i.test(name); }
