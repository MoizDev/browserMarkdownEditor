import React, { useRef } from 'react';

const DEFAULTS = { editorFontSize: 16, treeFontSize: 13, editorPadding: 6 };

export default function SettingsPanel({ editorFontSize, treeFontSize, editorPadding, fontFamily, onEditorFontSizeChange, onTreeFontSizeChange, onEditorPaddingChange, onFontFamilyChange, onResetDefaults, onClose }) {
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
