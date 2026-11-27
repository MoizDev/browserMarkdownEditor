import React, { useEffect, useMemo, useRef, useState } from 'react';
import LucideGlyph from './LucideGlyph';
import { ENTRY_COLORS, entryColorVar, type IconNode } from '../utils/entryStyle';
import { loadLucideIcons, searchIcons, type LucideIcon } from '../utils/lucideIcons';

interface FolderStylePickerProps {
    icon?: string;
    color?: string;
    onChange: (icon: string | undefined, color: string | undefined, nodes?: IconNode[]) => void;
    onClose: () => void;
}

const VISIBLE_ICONS = 180;

export default function EntryStylePicker({ icon: initialIcon, color: initialColor, onChange, onClose }: FolderStylePickerProps) {
    const [icon, setIcon] = useState(initialIcon);
    const [color, setColor] = useState(initialColor);

    const apply = (nextIcon: string | undefined, nextColor: string | undefined, nodes?: IconNode[]) => {
        setIcon(nextIcon);
        setColor(nextColor);
        onChange(nextIcon, nextColor, nodes);
    };

    const [icons, setIcons] = useState<LucideIcon[] | null>(null);
    const [failed, setFailed] = useState(false);
    const [query, setQuery] = useState('');
    const searchRef = useRef<HTMLInputElement | null>(null);

    useEffect(() => {
        let cancelled = false;
        loadLucideIcons().then(
            all => { if (!cancelled) setIcons(all); },
            err => {
                console.error('Could not load the icon set:', err);
                if (!cancelled) setFailed(true);
            },
        );
        return () => { cancelled = true; };
    }, []);

    useEffect(() => { searchRef.current?.focus({ preventScroll: true }); }, [icons]);

    const results = useMemo(
        () => (icons ? searchIcons(icons, query) : []),
        [icons, query],
    );
    const shown = results.slice(0, VISIBLE_ICONS);

    const nodesFor = (name: string) => icons?.find(i => i.name === name)?.nodes;

    return (
        <div
            className="folder-style-picker"
            onKeyDown={(e: React.KeyboardEvent) => {
                if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onClose(); }
            }}
        >
            <div className="folder-style-section">
                <span className="folder-style-heading">Colour</span>
                <div className="folder-style-colors">
                    {Object.entries(ENTRY_COLORS).map(([key, value]) => (
                        <button
                            key={key}
                            type="button"
                            className={`folder-style-color${color === key ? ' selected' : ''}`}
                            style={{ ['--folder-color' as string]: entryColorVar(key) }}
                            onClick={() => apply(icon, color === key ? undefined : key, nodesFor(icon ?? ''))}
                            aria-pressed={color === key}
                            aria-label={value.label}
                            data-tooltip={value.label}
                        />
                    ))}
                    <button
                        type="button"
                        className={`folder-style-color is-none${!color ? ' selected' : ''}`}
                        onClick={() => apply(icon, undefined, nodesFor(icon ?? ''))}
                        aria-pressed={!color}
                        aria-label="Default colour"
                        data-tooltip="Default colour"
                    />
                </div>
            </div>

            <div className="folder-style-section folder-style-icons-section">
                <span className="folder-style-heading">Icon</span>
                <input
                    ref={searchRef}
                    className="folder-style-search"
                    type="search"
                    value={query}
                    placeholder={icons ? `Search ${icons.length} icons…` : 'Loading icons…'}
                    onChange={e => setQuery(e.target.value)}
                    aria-label="Search icons"
                />

                {failed ? (
                    <p className="folder-style-empty">Could not load the icon set.</p>
                ) : !icons ? (
                    <p className="folder-style-empty">Loading…</p>
                ) : shown.length === 0 ? (
                    <p className="folder-style-empty">No icon matches “{query}”.</p>
                ) : (
                    <div className="folder-style-grid" role="listbox" aria-label="Icons">
                        {shown.map(entry => (
                            <button
                                key={entry.name}
                                type="button"
                                role="option"
                                aria-selected={icon === entry.name}
                                className={`folder-style-icon${icon === entry.name ? ' selected' : ''}`}
                                onClick={() => (icon === entry.name
                                    ? apply(undefined, color)
                                    : apply(entry.name, color, entry.nodes))}
                                data-tooltip={entry.name}
                                aria-label={entry.name}
                            >
                                <LucideGlyph nodes={entry.nodes} size={18} />
                            </button>
                        ))}
                    </div>
                )}
                {icons && results.length > shown.length && (
                    <p className="folder-style-more">
                        {results.length - shown.length} more — keep typing to narrow it down.
                    </p>
                )}
            </div>

            <button
                type="button"
                className="folder-style-reset"
                onClick={() => apply(undefined, undefined)}
                disabled={!icon && !color}
            >
                Reset to default
            </button>
        </div>
    );
}
