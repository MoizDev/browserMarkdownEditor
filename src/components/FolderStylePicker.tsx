import React, { useEffect, useMemo, useRef, useState } from 'react';
import LucideGlyph from './LucideGlyph';
import { FOLDER_COLORS, folderColorVar, type IconNode } from '../utils/folderStyle';
import { loadLucideIcons, searchIcons, type LucideIcon } from '../utils/lucideIcons';

interface FolderStylePickerProps {
    /** The folder's current icon name, if it has one. */
    icon?: string;
    /** The folder's current colour key, if it has one. */
    color?: string;
    /** Called on every choice — the tree updates live, so a pick can be seen
     *  against the real sidebar before the menu is dismissed. */
    onChange: (icon: string | undefined, color: string | undefined, nodes?: IconNode[]) => void;
    /** Close the flyout and hand the keyboard back to the menu row. */
    onClose: () => void;
}

/**
 * How many icons are rendered at once.
 *
 * All 1,818 mount as 1,818 inline SVGs of several nodes each, which is tens of
 * thousands of DOM elements for a panel showing about forty — measured at over a
 * second to open. The list is capped instead, and search is what reaches the
 * rest: typing three letters brings any icon within the first screen.
 */
const VISIBLE_ICONS = 180;

/**
 * "Choose icon / colour", as a flyout beside the folder's context-menu row.
 *
 * A flyout for the same reasons the table size picker is one (see ContextMenu):
 * no backdrop, no focus round trip, and it hangs off the row it belongs to. The
 * icon set is fetched on mount — this component is the only thing in the app
 * that pulls it, which is what keeps 91KB of icon data out of the main bundle.
 */
export default function FolderStylePicker({ icon: initialIcon, color: initialColor, onChange, onClose }: FolderStylePickerProps) {
    /* The picker owns the selection while it is open, seeded from the folder's
       current look. The context-menu entry that carries those in is built once,
       when the menu is raised, so reading them on every render would freeze the
       highlight at whatever the folder looked like before the first pick. */
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

    // Take the keyboard as the flyout opens: it is reached by ArrowRight from
    // the menu row, and searching is the first thing anyone wants to do.
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
                // Escape closes the flyout, not the whole menu — the menu's own
                // window-level Escape would otherwise take both at once.
                if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onClose(); }
            }}
        >
            <div className="folder-style-section">
                <span className="folder-style-heading">Colour</span>
                <div className="folder-style-colors">
                    {Object.entries(FOLDER_COLORS).map(([key, value]) => (
                        <button
                            key={key}
                            type="button"
                            className={`folder-style-color${color === key ? ' selected' : ''}`}
                            style={{ ['--folder-color' as string]: folderColorVar(key) }}
                            onClick={() => apply(icon, color === key ? undefined : key, nodesFor(icon ?? ''))}
                            aria-pressed={color === key}
                            aria-label={value.label}
                            title={value.label}
                        />
                    ))}
                    <button
                        type="button"
                        className={`folder-style-color is-none${!color ? ' selected' : ''}`}
                        onClick={() => apply(icon, undefined, nodesFor(icon ?? ''))}
                        aria-pressed={!color}
                        aria-label="Default colour"
                        title="Default colour"
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
                                // Picking the icon already chosen clears it, so
                                // the way back to a plain folder is the same
                                // gesture rather than a separate row.
                                onClick={() => (icon === entry.name
                                    ? apply(undefined, color)
                                    : apply(entry.name, color, entry.nodes))}
                                title={entry.name}
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
