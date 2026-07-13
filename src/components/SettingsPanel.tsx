import React, { useRef } from 'react';
import type { CaretStyle, SettingsDefaults } from '../types';

const DEFAULTS: SettingsDefaults = { editorFontSize: 16, treeFontSize: 13, editorPadding: 6, caretStyle: 'line', caretThickness: 10, smoothCaret: true, caretSpeed: 80, accentColor: '', codeBlockColor: '' };

/** What the swatch shows while no custom accent is set ('') — the dark theme's
 *  default purple. Purely cosmetic; '' still means "theme default". */
const ACCENT_SWATCH_FALLBACK = '#8b6cef';

interface SettingsPanelProps {
    editorFontSize: number;
    treeFontSize: number;
    editorPadding: number;
    fontFamily: string;
    caretStyle: CaretStyle;
    caretThickness: number;
    smoothCaret: boolean;
    caretSpeed: number;
    /** Custom accent as #rrggbb, or '' for the theme default. */
    accentColor: string;
    /** Ink for language-less ``` blocks as #rrggbb, or '' to follow the accent. */
    codeBlockColor: string;
    onEditorFontSizeChange: (v: number) => void;
    onTreeFontSizeChange: (v: number) => void;
    onEditorPaddingChange: (v: number) => void;
    onFontFamilyChange: (v: string) => void;
    onCaretStyleChange: (v: CaretStyle) => void;
    onCaretThicknessChange: (v: number) => void;
    onSmoothCaretChange: (v: boolean) => void;
    onCaretSpeedChange: (v: number) => void;
    onAccentColorChange: (v: string) => void;
    onCodeBlockColorChange: (v: string) => void;
    onResetDefaults: (defaults: SettingsDefaults) => void;
    onClose: () => void;
}

export default function SettingsPanel({ editorFontSize, treeFontSize, editorPadding, fontFamily, caretStyle, caretThickness, smoothCaret, caretSpeed, accentColor, codeBlockColor, onEditorFontSizeChange, onTreeFontSizeChange, onEditorPaddingChange, onFontFamilyChange, onCaretStyleChange, onCaretThicknessChange, onSmoothCaretChange, onCaretSpeedChange, onAccentColorChange, onCodeBlockColorChange, onResetDefaults, onClose }: SettingsPanelProps) {
    // Uncontrolled input (keyed on fontFamily) so we only load the Google Font
    // when the user commits the name, and it auto-resets on "Reset to Defaults".
    const fontInputRef = useRef<HTMLInputElement | null>(null);
    const applyFont = () => onFontFamilyChange((fontInputRef.current?.value || '').trim());

    return (
        <div className="settings-overlay" onClick={onClose}>
            <div className="settings-panel" onClick={(e) => e.stopPropagation()}>
                <div className="settings-header">
                    <h3 className="settings-title">Settings</h3>
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
