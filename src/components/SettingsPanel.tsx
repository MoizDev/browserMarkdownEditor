import React, { useEffect, useId, useRef, useState } from 'react';
import { DEFAULT_RECENT_VAULT_LIMIT, MAX_STORED_VAULTS } from '../utils/recentVaults';
import type { CaretStyle, SettingsDefaults } from '../types';

const DEFAULTS: SettingsDefaults = { editorFontSize: 16, treeFontSize: 13, editorPadding: 6, tabSize: 4, caretStyle: 'line', caretThickness: 10, smoothCaret: true, caretSpeed: 80, accentColor: '', codeBlockColor: '', recentVaultLimit: DEFAULT_RECENT_VAULT_LIMIT, showVaultInTitle: true };

/** What the swatch shows while no custom accent is set ('') — the dark theme's
 *  default purple. Purely cosmetic; '' still means "theme default". */
const ACCENT_SWATCH_FALLBACK = '#8b6cef';

interface SettingsPanelProps {
    editorFontSize: number;
    treeFontSize: number;
    editorPadding: number;
    /** Spaces a Tab inserts — and how far Tab indents a list item. */
    tabSize: number;
    fontFamily: string;
    caretStyle: CaretStyle;
    caretThickness: number;
    smoothCaret: boolean;
    caretSpeed: number;
    /** Custom accent as #rrggbb, or '' for the theme default. */
    accentColor: string;
    /** Ink for language-less ``` blocks as #rrggbb, or '' to follow the accent. */
    codeBlockColor: string;
    /** How many recently opened vaults the vault button's menu lists. */
    recentVaultLimit: number;
    /** Whether the browser tab is titled with the open vault's name. */
    showVaultInTitle: boolean;
    onEditorFontSizeChange: (v: number) => void;
    onTreeFontSizeChange: (v: number) => void;
    onEditorPaddingChange: (v: number) => void;
    onTabSizeChange: (v: number) => void;
    onFontFamilyChange: (v: string) => void;
    onCaretStyleChange: (v: CaretStyle) => void;
    onCaretThicknessChange: (v: number) => void;
    onSmoothCaretChange: (v: boolean) => void;
    onCaretSpeedChange: (v: number) => void;
    onAccentColorChange: (v: string) => void;
    onCodeBlockColorChange: (v: string) => void;
    onRecentVaultLimitChange: (v: number) => void;
    onShowVaultInTitleChange: (v: boolean) => void;
    onResetDefaults: (defaults: SettingsDefaults) => void;
    onClose: () => void;
}

export default function SettingsPanel({ editorFontSize, treeFontSize, editorPadding, tabSize, fontFamily, caretStyle, caretThickness, smoothCaret, caretSpeed, accentColor, codeBlockColor, recentVaultLimit, showVaultInTitle, onEditorFontSizeChange, onTreeFontSizeChange, onEditorPaddingChange, onTabSizeChange, onFontFamilyChange, onCaretStyleChange, onCaretThicknessChange, onSmoothCaretChange, onCaretSpeedChange, onAccentColorChange, onCodeBlockColorChange, onRecentVaultLimitChange, onShowVaultInTitleChange, onResetDefaults, onClose }: SettingsPanelProps) {
    // Uncontrolled input (keyed on fontFamily) so we only load the Google Font
    // when the user commits the name, and it auto-resets on "Reset to Defaults".
    const fontInputRef = useRef<HTMLInputElement | null>(null);
    const applyFont = () => onFontFamilyChange((fontInputRef.current?.value || '').trim());
    const titleId = useId();

    // A modal dialog (`aria-modal`, which DocumentPane's ⌘F guard also reads)
    // has to hold the keyboard, or a screen reader is told to ignore the very
    // place focus still is — the sidebar button that opened it. TrashPanel's
    // treatment: take it on open, from the opener read during the first render,
    // and hand it back on the way out; Escape closes.
    const panelRef = useRef<HTMLDivElement | null>(null);
    const [opener] = useState<HTMLElement | null>(() => document.activeElement as HTMLElement | null);
    useEffect(() => {
        panelRef.current?.focus({ preventScroll: true });
        return () => { if (opener?.isConnected) opener.focus({ preventScroll: true }); };
    }, [opener]);
    // And take it back whenever it falls on the floor: committing a font
    // remounts that field (it is keyed on the font), which drops the keyboard
    // on <body> with the dialog still open — and Escape, handled on the panel,
    // then did nothing (measured). Every commit, as TrashPanel does.
    useEffect(() => {
        const active = document.activeElement;
        if (!active || active === document.body) panelRef.current?.focus({ preventScroll: true });
    });

    return (
        <div className="settings-overlay" onClick={onClose}>
            <div
                className="settings-panel"
                role="dialog"
                aria-modal="true"
                aria-labelledby={titleId}
                tabIndex={-1}
                ref={panelRef}
                onClick={(e) => e.stopPropagation()}
                onKeyDown={(e) => {
                    if (e.key !== 'Escape' || e.defaultPrevented) return;
                    e.preventDefault();
                    onClose();
                }}
            >
                <div className="settings-header">
                    <h3 className="settings-title" id={titleId}>Settings</h3>
                    <button className="settings-close-btn" onClick={onClose}>×</button>
                </div>
                <div className="settings-body">
                    <h4 className="settings-section">Appearance</h4>

                    <div className="setting-row">
                        <div className="setting-info">
                            <div className="setting-name">Editor font size</div>
                        </div>
                        <div className="setting-control">
                            <span className="settings-value">{editorFontSize}px</span>
                            <input
                                type="range"
                                min="12"
                                max="28"
                                step="1"
                                value={editorFontSize}
                                onChange={(e) => onEditorFontSizeChange(parseInt(e.target.value, 10))}
                                className="settings-slider"
                            />
                        </div>
                    </div>

                    <div className="setting-row">
                        <div className="setting-info">
                            <div className="setting-name">File tree font size</div>
                        </div>
                        <div className="setting-control">
                            <span className="settings-value">{treeFontSize}px</span>
                            <input
                                type="range"
                                min="10"
                                max="20"
                                step="1"
                                value={treeFontSize}
                                onChange={(e) => onTreeFontSizeChange(parseInt(e.target.value, 10))}
                                className="settings-slider"
                            />
                        </div>
                    </div>

                    <div className="setting-row">
                        <div className="setting-info">
                            <div className="setting-name">Text width (padding)</div>
                        </div>
                        <div className="setting-control">
                            <span className="settings-value">{editorPadding}%</span>
                            <input
                                type="range"
                                min="0"
                                max="20"
                                step="1"
                                value={editorPadding}
                                onChange={(e) => onEditorPaddingChange(parseInt(e.target.value, 10))}
                                className="settings-slider"
                            />
                        </div>
                    </div>

                    <div className="setting-row">
                        <div className="setting-info">
                            <div className="setting-name">Font</div>
                            <div className="settings-hint">
                                Any font name from <a href="https://fonts.google.com" target="_blank" rel="noreferrer">Google Fonts</a>; it loads automatically. Leave blank for the default.
                            </div>
                        </div>
                        <div className="setting-control">
                            <input
                                id="font-input"
                                key={fontFamily}
                                ref={fontInputRef}
                                type="text"
                                className="settings-text-input"
                                placeholder="e.g. Inter, Lora"
                                defaultValue={fontFamily}
                                onBlur={applyFont}
                                onKeyDown={(e) => { if (e.key === 'Enter') applyFont(); }}
                                spellCheck={false}
                                autoCorrect="off"
                            />
                            <button className="settings-apply-btn" onClick={applyFont}>Apply</button>
                        </div>
                    </div>

                    <h4 className="settings-section">Editing</h4>

                    <div className="setting-row">
                        <div className="setting-info">
                            <div className="setting-name">Tab size</div>
                            <div className="settings-hint">
                                Spaces a Tab inserts — and how far it indents a list item.
                            </div>
                        </div>
                        <div className="setting-control">
                            <span className="settings-value">{tabSize} spaces</span>
                            <input
                                id="tab-size-input"
                                type="range"
                                min="1"
                                max="8"
                                step="1"
                                value={tabSize}
                                onChange={(e) => onTabSizeChange(parseInt(e.target.value, 10))}
                                className="settings-slider"
                            />
                        </div>
                    </div>

                    <h4 className="settings-section">Vault</h4>

                    <div className="setting-row">
                        <div className="setting-info">
                            <div className="setting-name">Vault name as tab title</div>
                            <div className="settings-hint">
                                Titles the browser tab with the open vault's name. Off, it stays “Markdown Editor”.
                            </div>
                        </div>
                        <div className="setting-control">
                            <button
                                id="vault-title-toggle"
                                role="switch"
                                aria-checked={showVaultInTitle}
                                className={`settings-toggle${showVaultInTitle ? ' on' : ''}`}
                                onClick={() => onShowVaultInTitleChange(!showVaultInTitle)}
                            >
                                <span className="settings-toggle-knob" />
                            </button>
                        </div>
                    </div>

                    <div className="setting-row">
                        <div className="setting-info">
                            <div className="setting-name">Recent vaults shown</div>
                            <div className="settings-hint">
                                How many recently opened vaults the file tree's vault button lists.
                                Double-click that button to browse for a folder instead.
                            </div>
                        </div>
                        <div className="setting-control">
                            <span className="settings-value">{recentVaultLimit}</span>
                            <input
                                id="recent-vault-limit-input"
                                type="range"
                                min="1"
                                max={MAX_STORED_VAULTS}
                                step="1"
                                value={recentVaultLimit}
                                onChange={(e) => onRecentVaultLimitChange(parseInt(e.target.value, 10))}
                                className="settings-slider"
                            />
                        </div>
                    </div>

                    <h4 className="settings-section">Colors</h4>

                    <div className="setting-row">
                        <div className="setting-info">
                            <div className="setting-name">Accent color</div>
                            <div className="settings-hint">
                                Recolors links, code, buttons and highlights in both themes.
                            </div>
                        </div>
                        <div className="setting-control">
                            {accentColor && (
                                <button className="settings-apply-btn" onClick={() => onAccentColorChange('')}>
                                    Use Theme Default
                                </button>
                            )}
                            <input
                                id="accent-color-input"
                                type="color"
                                className="settings-color-input"
                                value={accentColor || ACCENT_SWATCH_FALLBACK}
                                onChange={(e) => onAccentColorChange(e.target.value)}
                            />
                        </div>
                    </div>

                    <div className="setting-row">
                        <div className="setting-info">
                            <div className="setting-name">Plain code block color</div>
                            <div className="settings-hint">
                                Text color for ``` blocks without a language tag; blocks with a
                                language keep their syntax colors. Follows the accent until set.
                            </div>
                        </div>
                        <div className="setting-control">
                            {codeBlockColor && (
                                <button className="settings-apply-btn" onClick={() => onCodeBlockColorChange('')}>
                                    Follow Accent
                                </button>
                            )}
                            <input
                                id="codeblock-color-input"
                                type="color"
                                className="settings-color-input"
                                value={codeBlockColor || accentColor || ACCENT_SWATCH_FALLBACK}
                                onChange={(e) => onCodeBlockColorChange(e.target.value)}
                            />
                        </div>
                    </div>

                    <h4 className="settings-section">Caret</h4>

                    <div className="setting-row">
                        <div className="setting-info">
                            <div className="setting-name">Caret style</div>
                            <div className="settings-hint">
                                “Block” gives a thick, terminal-style caret. “Line” is a thin bar.
                            </div>
                        </div>
                        <div className="setting-control">
                            <div className="settings-segmented">
                                <button
                                    className={`settings-segment${caretStyle === 'line' ? ' active' : ''}`}
                                    onClick={() => onCaretStyleChange('line')}
                                >
                                    Line
                                </button>
                                <button
                                    className={`settings-segment${caretStyle === 'block' ? ' active' : ''}`}
                                    onClick={() => onCaretStyleChange('block')}
                                >
                                    Block
                                </button>
                            </div>
                        </div>
                    </div>

                    {caretStyle === 'line' && (
                        <div className="setting-row">
                            <div className="setting-info">
                                <div className="setting-name">Caret thickness</div>
                            </div>
                            <div className="setting-control">
                                <span className="settings-value">{caretThickness}px</span>
                                <input
                                    type="range"
                                    min="1"
                                    max="10"
                                    step="1"
                                    value={caretThickness}
                                    onChange={(e) => onCaretThicknessChange(parseInt(e.target.value, 10))}
                                    className="settings-slider"
                                />
                            </div>
                        </div>
                    )}

                    <div className="setting-row">
                        <div className="setting-info">
                            <div className="setting-name">Smooth caret motion</div>
                            <div className="settings-hint">
                                Glides the caret between positions for a smooth, MS Word–like feel.
                            </div>
                        </div>
                        <div className="setting-control">
                            <button
                                id="smooth-caret-toggle"
                                role="switch"
                                aria-checked={smoothCaret}
                                className={`settings-toggle${smoothCaret ? ' on' : ''}`}
                                onClick={() => onSmoothCaretChange(!smoothCaret)}
                            >
                                <span className="settings-toggle-knob" />
                            </button>
                        </div>
                    </div>

                    {smoothCaret && (
                        <div className="setting-row">
                            <div className="setting-info">
                                <div className="setting-name">Caret animation speed</div>
                                <div className="settings-hint">
                                    Higher is slower and more pronounced; lower is snappier.
                                </div>
                            </div>
                            <div className="setting-control">
                                <span className="settings-value">{caretSpeed}ms</span>
                                <input
                                    type="range"
                                    min="20"
                                    max="200"
                                    step="10"
                                    value={caretSpeed}
                                    onChange={(e) => onCaretSpeedChange(parseInt(e.target.value, 10))}
                                    className="settings-slider"
                                />
                            </div>
                        </div>
                    )}

                    <div className="settings-footer">
                        <button
                            className="settings-reset-btn"
                            onClick={() => onResetDefaults(DEFAULTS)}
                        >
                            Reset to Defaults
                        </button>
                    </div>
                </div>
            </div>
        </div>
    );
}

export { DEFAULTS };
