import React, { useRef } from 'react';

const DEFAULTS = { editorFontSize: 16, treeFontSize: 13, editorPadding: 6, caretStyle: 'line', caretThickness: 2, smoothCaret: false, caretSpeed: 80 };

export default function SettingsPanel({ editorFontSize, treeFontSize, editorPadding, fontFamily, caretStyle, caretThickness, smoothCaret, caretSpeed, onEditorFontSizeChange, onTreeFontSizeChange, onEditorPaddingChange, onFontFamilyChange, onCaretStyleChange, onCaretThicknessChange, onSmoothCaretChange, onCaretSpeedChange, onResetDefaults, onClose }) {
    // Uncontrolled input (keyed on fontFamily) so we only load the Google Font
    // when the user commits the name, and it auto-resets on "Reset to Defaults".
    const fontInputRef = useRef(null);
    const applyFont = () => onFontFamilyChange((fontInputRef.current?.value || '').trim());

    return (
        <div className="settings-overlay" onClick={onClose}>
            <div className="settings-panel" onClick={(e) => e.stopPropagation()}>
                <div className="settings-header">
                    <h3 className="settings-title">Settings</h3>
                    <button className="settings-close-btn" onClick={onClose}>×</button>
                </div>
                <div className="settings-body">
                    <div className="settings-group">
                        <label className="settings-label">
                            Editor Font Size
                            <span className="settings-value">{editorFontSize}px</span>
                        </label>
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
                    <div className="settings-group">
                        <label className="settings-label">
                            File Tree Font Size
                            <span className="settings-value">{treeFontSize}px</span>
                        </label>
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
                    <div className="settings-group">
                        <label className="settings-label">
                            Text Width (Padding)
                            <span className="settings-value">{editorPadding}%</span>
                        </label>
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
                    <div className="settings-group">
                        <label className="settings-label" htmlFor="font-input">
                            Font
                            {fontFamily && <span className="settings-value">{fontFamily}</span>}
                        </label>
                        <div className="settings-font-row">
                            <input
                                id="font-input"
                                key={fontFamily}
                                ref={fontInputRef}
                                type="text"
                                className="settings-text-input"
                                placeholder="e.g. Inter, Lora, JetBrains Mono"
                                defaultValue={fontFamily}
                                onBlur={applyFont}
                                onKeyDown={(e) => { if (e.key === 'Enter') applyFont(); }}
                                spellCheck={false}
                                autoCorrect="off"
                            />
                            <button className="settings-apply-btn" onClick={applyFont}>Apply</button>
                        </div>
                        <p className="settings-hint">
                            Type any font name from <a href="https://fonts.google.com" target="_blank" rel="noreferrer">Google Fonts</a>; it loads automatically. Leave blank for the default.
                        </p>
                    </div>
                    <div className="settings-group">
                        <label className="settings-label">Caret Style</label>
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
                        <p className="settings-hint">
                            “Block” gives a thick, terminal-style caret. “Line” is a thin bar.
                        </p>
                    </div>
                    {caretStyle === 'line' && (
                        <div className="settings-group">
                            <label className="settings-label">
                                Caret Thickness
                                <span className="settings-value">{caretThickness}px</span>
                            </label>
                            <input
                                type="range"
                                min="1"
                                max="6"
                                step="1"
                                value={caretThickness}
                                onChange={(e) => onCaretThicknessChange(parseInt(e.target.value, 10))}
                                className="settings-slider"
                            />
                        </div>
                    )}
                    <div className="settings-group">
                        <label className="settings-label" htmlFor="smooth-caret-toggle">
                            Smooth Caret Motion
                            <button
                                id="smooth-caret-toggle"
                                role="switch"
                                aria-checked={smoothCaret}
                                className={`settings-toggle${smoothCaret ? ' on' : ''}`}
                                onClick={() => onSmoothCaretChange(!smoothCaret)}
                            >
                                <span className="settings-toggle-knob" />
                            </button>
                        </label>
                        <p className="settings-hint">
                            Glides the caret between positions for a smooth, MS Word–like feel.
                        </p>
                    </div>
                    {smoothCaret && (
                        <div className="settings-group">
                            <label className="settings-label">
                                Caret Animation Speed
                                <span className="settings-value">{caretSpeed}ms</span>
                            </label>
                            <input
                                type="range"
                                min="20"
                                max="200"
                                step="10"
                                value={caretSpeed}
                                onChange={(e) => onCaretSpeedChange(parseInt(e.target.value, 10))}
                                className="settings-slider"
                            />
                            <p className="settings-hint">
                                Higher is slower and more pronounced; lower is snappier.
                            </p>
                        </div>
                    )}
                    <button
                        className="settings-reset-btn"
                        onClick={() => onResetDefaults(DEFAULTS)}
                    >
                        Reset to Defaults
                    </button>
                </div>
            </div>
        </div>
    );
}

export { DEFAULTS };
