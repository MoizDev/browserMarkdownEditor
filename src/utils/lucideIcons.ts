import type { IconNode } from './entryStyle';
import { loadChunk } from '../platform/chunkLoad';

export interface LucideIcon {
    name: string;
    nodes: IconNode[];
    keywords: string[];
}

export const SUGGESTED_ICONS = [
    'folder', 'folder-open', 'folder-git-2', 'archive', 'inbox', 'files', 'paperclip', 'bookmark', 'tag', 'pin',
    'book', 'book-open', 'book-marked', 'library', 'graduation-cap', 'school', 'notebook-pen', 'file-text', 'clipboard-list', 'presentation',
    'flask-conical', 'atom', 'microscope', 'brain', 'sigma', 'square-function', 'calculator', 'binary', 'chart-line', 'chart-pie',
    'code', 'terminal', 'braces', 'database', 'server', 'cpu', 'git-branch', 'bug', 'settings', 'wrench',
    'briefcase', 'building-2', 'calendar', 'receipt', 'trending-up', 'dollar-sign', 'wallet', 'shopping-cart', 'mail', 'phone',
    'image', 'camera', 'video', 'film', 'music', 'mic', 'palette', 'brush', 'pen-tool', 'gamepad-2',
    'heart', 'star', 'flag', 'target', 'lightbulb', 'rocket', 'sparkles', 'zap', 'flame', 'clock',
    'globe', 'map', 'plane', 'car', 'house', 'users', 'user', 'message-square', 'bell', 'shield',
    'dumbbell', 'utensils', 'coffee', 'leaf', 'sun', 'moon', 'cloud', 'lock', 'key', 'trash',
];

let loading: Promise<LucideIcon[]> | null = null;

export function loadLucideIcons(): Promise<LucideIcon[]> {
    loading ??= (async () => {
        const [nodes, tags] = await Promise.all([
            loadChunk(() => import('lucide-static/icon-nodes.json')),
            loadChunk(() => import('lucide-static/tags.json')),
        ]);
        const iconNodes = nodes.default as unknown as Record<string, IconNode[]>;
        const iconTags = tags.default as unknown as Record<string, string[]>;

        return Object.keys(iconNodes).sort().map(name => ({
            name,
            nodes: iconNodes[name],
            keywords: [...new Set([...name.split('-'), ...(iconTags[name] ?? [])])],
        }));
    })().catch(err => {
        loading = null;
        throw err;
    });
    return loading;
}

export function searchIcons(icons: LucideIcon[], query: string): LucideIcon[] {
    const q = query.trim().toLowerCase();
    if (!q) {
        const byName = new Map(icons.map(i => [i.name, i]));
        const suggested = SUGGESTED_ICONS.map(n => byName.get(n)).filter((i): i is LucideIcon => !!i);
        const seen = new Set(suggested.map(i => i.name));
        return [...suggested, ...icons.filter(i => !seen.has(i.name))];
    }

    const scored: Array<{ icon: LucideIcon; rank: number }> = [];
    for (const icon of icons) {
        const name = icon.name;
        let rank: number;
        if (name === q) rank = 0;
        else if (name.startsWith(q)) rank = 1;
        else if (name.includes(q)) rank = 2;
        else if (icon.keywords.some(k => k === q)) rank = 3;
        else if (icon.keywords.some(k => k.startsWith(q))) rank = 4;
        else continue;
        scored.push({ icon, rank });
    }
    scored.sort((a, b) => a.rank - b.rank);
    return scored.map(s => s.icon);
}
